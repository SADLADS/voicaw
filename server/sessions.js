const WebSocket = require('ws');
const db = require('./db');
const { clients, pendingClients } = require('./sockets');

// Login sessions (the `sessions` table; tokens carry their id, see auth.js): Settings →
// Devices lists them and logs them out.

// `userId`'s sessions, the `current` one (`currentId`) first, then most recently used first,
// with whether each is `online` (has an open socket).
async function listSessions(userId, currentId) {
  const rows = await db.all(
    `SELECT id, created_at, last_used_at, user_agent, ip FROM sessions
     WHERE user_id = ? ORDER BY id = ? DESC, last_used_at DESC, created_at DESC`,
    [userId, currentId]
  );
  const sockets = clients.get(String(userId)) ?? pendingClients.get(String(userId)) ?? [];
  return rows.map((row) => ({
    ...row,
    current: row.id === currentId,
    online: sockets.some((s) => s.sessionId === row.id && s.readyState === WebSocket.OPEN),
  }));
}

// Logs out `userId`'s sessions `ids`: their tokens stop working, their push subscriptions go,
// and their open sockets are told (`session_revoked`, the app logs out) and closed.
// `fromSettings` also removes the push subscriptions from before login sessions (no session
// id): they could be the device being logged out.
async function endSessions(userId, ids, { fromSettings = true } = {}) {
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(', ');
  await db.transaction(async () => {
    await db.run(`DELETE FROM sessions WHERE user_id = ? AND id IN (${marks})`, [userId, ...ids]);
    await db.run(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND (session_id IN (${marks})${fromSettings ? ' OR session_id IS NULL' : ''})`,
      [userId, ...ids]
    );
  });
  console.log(`Sessions ended (${fromSettings ? 'from Settings' : 'logout'}): user ${userId}, ${ids.map((id) => id.slice(0, 6)).join(', ')}`);
  const ended = new Set(ids);
  const message = JSON.stringify({ type: 'session_revoked' });
  for (const socket of [...(clients.get(String(userId)) ?? []), ...(pendingClients.get(String(userId)) ?? [])]) {
    if (!ended.has(socket.sessionId) || socket.readyState !== WebSocket.OPEN) continue;
    socket.send(message);
    socket.close(1008, 'Logged out');
  }
}

module.exports = { listSessions, endSessions };
