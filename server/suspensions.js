const db = require('./db');
const { clients, sendToUserSockets, closePendingSockets } = require('./sockets');

// Suspending an account (global admins, Settings → Admin, usually from a report): it's logged out
// everywhere (sessions and push subscriptions gone, calls and voice ended, open apps told
// `account_suspended` and closed), and can't log in again until lifted (auth.js verifyToken,
// routes/auth.js). Its messages and memberships stay as they are; others see nothing change.
// Its bots are paused with it (security audit, 2026-11-18): their gateway sessions are closed and
// their tokens and OAuth secrets refused (bots.js botForToken, oauth.js clientFor) until lifted.

const now = () => Math.floor(Date.now() / 1000);

class SuspensionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function suspend(userId, adminId, reason) {
  const user = await db.get('SELECT id, is_admin, bot, deleted_at, suspended_at FROM users WHERE id = ?', [userId]);
  if (!user || user.deleted_at) throw new SuspensionError(404, 'User not found');
  if (user.bot) throw new SuspensionError(400, 'Bots are removed from guilds, not suspended');
  if (userId === adminId) throw new SuspensionError(400, "You can't suspend yourself");
  if (user.is_admin) throw new SuspensionError(400, 'Remove them as an admin first');
  const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null;
  await db.transaction(async () => {
    await db.run('UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?', [user.suspended_at ?? now(), why, userId]);
    await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
  });
  await require('./calls').endCallOf(userId);
  await require('./voice').disconnect(userId);
  sendToUserSockets(userId, { type: 'account_suspended', reason: why });
  for (const socket of clients.get(String(userId)) ?? []) socket.close(1008, 'Account suspended');
  // An account still waiting for approval has its sockets apart; approving it later would
  // otherwise move them into `clients`.
  closePendingSockets(userId, { notice: { type: 'account_suspended', reason: why }, reason: 'Account suspended' });
  const bots = await db.all('SELECT id FROM bot_applications WHERE owner_id = ?', [userId]);
  for (const { id } of bots) {
    require('./gateway').closeBotSessions(id, 4004, 'Authentication failed.');
    await require('./voice').disconnect(id);
  }
}

async function lift(userId) {
  const { changes } = await db.run(
    'UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ? AND suspended_at IS NOT NULL',
    [userId]
  );
  return changes > 0;
}

const listSuspended = () => db.all(
  'SELECT id, username, display_name, suspended_at, suspended_reason FROM users WHERE suspended_at IS NOT NULL ORDER BY suspended_at DESC'
);

module.exports = { SuspensionError, suspend, lift, listSuspended };
