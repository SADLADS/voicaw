const db = require('./db');
const { PERMISSIONS, has, channelPermissions } = require('./permissions');

// A guild's audit log, like Discord's: who did what, to what, and when (guild_audit_log, see
// db.js). Routes call logAudit, inside their transaction when they have one. Only members with
// View Audit Log read it (routes/auditLog.js), and an entry about a channel only shows to
// those who can see that channel (or, once it's deleted, to everyone reading the log if it
// wasn't private, else only administrators and the owner).
//
// Actions (`details` holds the names as they were, since the things themselves may be gone):
//   guild_update { changes: { name: [before, after] }, icon: 'changed' | 'removed' }
//   guild_owner_transfer (target: the new owner)
//   channel_create / channel_delete { name, type }, channel_update { name, changes }
//   category_create / category_delete { name }, category_update { name, changes }
//   channel_override_update { channelName, targetName, before: { allow, deny }, after }
//     (target: the role or member)
//   role_create / role_delete { name }, role_update { name, changes }
//   member_role_update { added: [{ id, name }], removed } (target: the member)
//   member_kick, member_ban_add, member_ban_remove (target: the user)
//   invite_create { code, maxAge, maxUses }, invite_delete { code }
//   emoji_create / emoji_delete { name }, emoji_update { changes }
//   webhook_create / webhook_delete { name, channelName }, webhook_update { name, changes }
//   message_delete { messageId, sentAt, channelName, webhookName? } (target: the author)
//   message_pin / message_unpin { messageId, channelName } (target: the author)
// Never a message's content: deleting it should get rid of it.

const RETENTION_DAYS = 90;
const MAX_PAGE = 100;

const now = () => Math.floor(Date.now() / 1000);

// Whether @everyone can't see the channel right now.
async function isPrivateChannel(channelId) {
  const row = await db.get(
    `SELECT o.deny FROM guild_channel_overrides o
     JOIN guild_channels c ON c.id = o.channel_id
     JOIN guild_roles r ON r.guild_id = c.guild_id AND r.is_everyone = 1
     WHERE o.channel_id = ? AND o.target_type = 'role' AND o.target_id = r.id`,
    [channelId]
  );
  return Boolean(row && has(row.deny, PERMISSIONS.VIEW_CHANNEL));
}

// Records one entry. `actorId` is the user who did it; a webhook acting with its token passes
// `webhookId` instead. Entries older than RETENTION_DAYS are dropped as new ones come in.
async function logAudit({ guildId, action, actorId = null, webhookId = null, targetType = null, targetId = null, channelId = null, details = null }) {
  const isPrivate = channelId != null && await isPrivateChannel(channelId);
  await db.run(
    `INSERT INTO guild_audit_log
       (guild_id, action, actor_id, actor_webhook_id, target_type, target_id, channel_id, private, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, action, actorId, webhookId, targetType, targetId == null ? null : String(targetId),
      channelId, isPrivate ? 1 : 0, details ? JSON.stringify(details) : null, now()]
  );
  await db.run('DELETE FROM guild_audit_log WHERE guild_id = ? AND created_at < ?', [guildId, now() - RETENTION_DAYS * 86400]);
}

// [before, after] for each field of `after` that differs from `before` (undefined ones skipped).
function diff(before, after) {
  const changes = {};
  for (const [key, value] of Object.entries(after)) {
    if (value !== undefined && before[key] !== value) changes[key] = [before[key] ?? null, value];
  }
  return changes;
}

// Whether `member` may see the entry (see the top of this file).
function visibleTo(member, entry, channels, overrides) {
  if (entry.channel_id == null) return true;
  if (!channels.has(entry.channel_id)) return !entry.private || has(member.permissions, PERMISSIONS.ADMINISTRATOR);
  return has(channelPermissions(member, member.userId, overrides.get(entry.channel_id) ?? []), PERMISSIONS.VIEW_CHANNEL);
}

// A page of the log as `member` may see it, newest first: `limit` entries (1–100, default 50)
// before entry id `before`, optionally only the given `actions` or only those by `actorId`.
// -> { entries, users, webhooks, next } (`next`: the `before` for the next page, null at the end).
async function readAuditLog(member, { before = null, limit = 50, actions = null, actorId = null } = {}) {
  const { getOverrides } = require('./guilds');
  const guildId = member.guild.id;
  const channels = new Set((await db.all('SELECT id FROM guild_channels WHERE guild_id = ?', [guildId])).map((c) => c.id));
  const overrides = await getOverrides({ guildId });

  const where = ['guild_id = ?'];
  const params = [guildId];
  if (actions?.length) {
    where.push(`action IN (${actions.map(() => '?').join(',')})`);
    params.push(...actions);
  }
  if (actorId != null) {
    where.push('actor_id = ?');
    params.push(actorId);
  }

  // Entries the member can't see are skipped, so read on until the page is full.
  const entries = [];
  let cursor = before;
  let exhausted = false;
  while (entries.length < limit && !exhausted) {
    const rows = await db.all(
      `SELECT * FROM guild_audit_log WHERE ${where.join(' AND ')}${cursor != null ? ' AND id < ?' : ''}
       ORDER BY id DESC LIMIT ?`,
      [...params, ...(cursor != null ? [cursor] : []), MAX_PAGE]
    );
    if (rows.length < MAX_PAGE) exhausted = true;
    for (const row of rows) {
      cursor = row.id;
      if (!visibleTo(member, row, channels, overrides)) continue;
      entries.push({ ...row, private: undefined, details: row.details ? JSON.parse(row.details) : {} });
      if (entries.length === limit) break;
    }
  }
  const next = entries.length === limit ? entries[entries.length - 1].id : null;

  // Everyone the page names, as they are now (people who left included).
  const userIds = new Set();
  const webhookIds = new Set();
  for (const e of entries) {
    if (e.actor_id != null) userIds.add(e.actor_id);
    if (e.actor_webhook_id != null) webhookIds.add(e.actor_webhook_id);
    if (e.target_type === 'user') userIds.add(Number(e.target_id));
    if (e.target_type === 'webhook') webhookIds.add(Number(e.target_id));
  }
  const users = userIds.size ? await db.all(
    `SELECT id, username, display_name, avatar FROM users WHERE id IN (${[...userIds].map(() => '?').join(',')})`,
    [...userIds]
  ) : [];
  const webhooks = webhookIds.size ? await db.all(
    `SELECT id, name, avatar FROM guild_webhooks WHERE guild_id = ? AND id IN (${[...webhookIds].map(() => '?').join(',')})`,
    [guildId, ...webhookIds]
  ) : [];
  return { entries, users, webhooks, next };
}

module.exports = { RETENTION_DAYS, logAudit, diff, readAuditLog };
