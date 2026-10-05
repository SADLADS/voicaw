const db = require('./db');

// Blocking (the `user_blocks` table): when someone blocks another person, neither can DM, call
// or add the other to a group DM (the server refuses either side; the blocked person is only
// told it couldn't be delivered), and the blocker isn't pushed about the other's group messages,
// guild mentions or group calls. In guilds and groups the app collapses the blocked person's
// messages for the blocker ("Blocked message · Show"); everyone else sees them as usual.

const now = () => Math.floor(Date.now() / 1000);

// The ids `userId` has blocked.
async function blockedBy(userId) {
  const rows = await db.all('SELECT blocked_id FROM user_blocks WHERE blocker_id = ? ORDER BY created_at DESC', [userId]);
  return rows.map((r) => r.blocked_id);
}

// Whether either of `a` and `b` has blocked the other.
async function blockedBetween(a, b) {
  if (a == null || b == null || a === b) return false;
  return Boolean(await db.get(
    'SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
    [a, b, b, a]
  ));
}

// Of `userIds`, those who have blocked `senderId` (not to be pushed about what they send).
async function blockersAmong(senderId, userIds) {
  if (!userIds.length) return new Set();
  const marks = userIds.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT blocker_id FROM user_blocks WHERE blocked_id = ? AND blocker_id IN (${marks})`,
    [senderId, ...userIds]
  );
  return new Set(rows.map((r) => r.blocker_id));
}

async function block(blockerId, blockedId) {
  await db.run(
    'INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    [blockerId, blockedId, now()]
  );
}

async function unblock(blockerId, blockedId) {
  await db.run('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]);
}

// What the blocked side is told (never that they're blocked, as in Discord).
const NOT_DELIVERED = "Your message couldn't be delivered";

module.exports = { blockedBy, blockedBetween, blockersAmong, block, unblock, NOT_DELIVERED };
