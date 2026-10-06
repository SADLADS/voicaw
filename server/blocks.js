const db = require('./db');

// Blocking (the `user_blocks` table): when someone blocks another person, neither can DM, call
// or add the other to a group DM (the server refuses either side; the blocked person is only
// told it couldn't be delivered), and the blocker isn't pushed about the other's group messages,
// guild mentions or group calls. In guilds and groups the app collapses the blocked person's
// messages for the blocker ("Blocked message · Show"); everyone else sees them as usual.
//
// Webhooks (`webhook_blocks`) can be blocked too, by anyone in a guild they've posted in: their
// messages are collapsed the same way and the blocker isn't pushed about them. Nothing else
// changes (a webhook has no DMs or calls).

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

// The webhooks `userId` has blocked, newest first: [{ id, name, guild_id, guild_name }] (the
// webhook's name now, or the one it had if it's been deleted).
async function webhooksBlockedBy(userId) {
  return db.all(
    `SELECT wb.webhook_id AS id, COALESCE(w.name, wb.name) AS name, wb.guild_id, g.name AS guild_name
     FROM webhook_blocks wb
     LEFT JOIN guild_webhooks w ON w.id = wb.webhook_id
     LEFT JOIN guilds g ON g.id = wb.guild_id
     WHERE wb.user_id = ? ORDER BY wb.created_at DESC, wb.webhook_id DESC`,
    [userId]
  );
}

// What `userId` blocks, as sent to the app (GET /blocks, the `blocks` event).
async function blockList(userId) {
  return { blocked: await blockedBy(userId), webhooks: await webhooksBlockedBy(userId) };
}

// Of `userIds`, those who have blocked webhook `webhookId`.
async function webhookBlockersAmong(webhookId, userIds) {
  if (!userIds.length) return new Set();
  const marks = userIds.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT user_id FROM webhook_blocks WHERE webhook_id = ? AND user_id IN (${marks})`,
    [webhookId, ...userIds]
  );
  return new Set(rows.map((r) => r.user_id));
}

// Blocks webhook `webhookId` for `userId`, if it has posted in a guild they're in (it may since
// have been deleted). False if not: no such webhook as far as they can tell.
async function blockWebhook(userId, webhookId) {
  const hook = await db.get(
    'SELECT w.guild_id, w.name FROM guild_webhooks w JOIN guild_members gm ON gm.guild_id = w.guild_id AND gm.user_id = ? WHERE w.id = ?',
    [userId, webhookId]
  ) ?? await db.get(
    `SELECT c.guild_id, m.webhook_name AS name FROM guild_messages m
     JOIN guild_channels c ON c.id = m.channel_id
     JOIN guild_members gm ON gm.guild_id = c.guild_id AND gm.user_id = ?
     WHERE m.webhook_id = ? ORDER BY m.id DESC LIMIT 1`,
    [userId, webhookId]
  );
  if (!hook) return false;
  await db.run(
    'INSERT INTO webhook_blocks (user_id, webhook_id, guild_id, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    [userId, webhookId, hook.guild_id, hook.name ?? '', now()]
  );
  return true;
}

async function unblockWebhook(userId, webhookId) {
  await db.run('DELETE FROM webhook_blocks WHERE user_id = ? AND webhook_id = ?', [userId, webhookId]);
}

// What the blocked side is told (never that they're blocked, as in Discord).
const NOT_DELIVERED = "Your message couldn't be delivered";

module.exports = {
  blockedBy, blockedBetween, blockersAmong, block, unblock, NOT_DELIVERED,
  blockList, webhookBlockersAmong, blockWebhook, unblockWebhook,
};
