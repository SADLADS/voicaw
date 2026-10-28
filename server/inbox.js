const db = require('./db');
const { PERMISSIONS, has } = require('./permissions');
const { getChannelAccess } = require('./guilds');
const { blockList } = require('./blocks');
const { isConversationMuted } = require('./conversationSettings');
const { buildDmPushPayload, buildGroupPushPayload, getUserImageUrl } = require('./push');
const { previewText, channelPushPayload } = require('./mentions');
const { parseJsonList } = require('./routes/guildMessages');
const { displayNameOf } = require('./profiles');

// The desktop app's inbox (client components/Inbox.jsx): what notified you lately, worked out
// from what's already stored, nothing kept for it. Each entry carries the payload its push
// carried (push.js, mentions.js), so the app words it as it words notifications, decrypting DM
// and group previews on the device; the server learns nothing it didn't hold already.
// - a DM, a group or a bot DM: its newest message from someone else (their pushes replace each
//   other, one per conversation), unless the conversation is muted now
// - a guild: every message mentioning you or replying to you, in channels you can still see,
//   unless your notification level there is None
// Never from someone you blocked. Deleted messages are gone from it with their rows.
const INBOX_DAYS = 30;
const INBOX_LIMIT = 50;

const since = () => Math.floor(Date.now() / 1000) - INBOX_DAYS * 24 * 60 * 60;

async function dmEntries(userId, blocked, from) {
  const rows = await db.all(
    `SELECT dm.id, dm.sender_id, dm.recipient_id, dm.content, dm.timestamp,
       u.username AS sender_username, u.display_name AS sender_display_name,
       (un.user_id IS NOT NULL) AS unread
     FROM direct_messages dm
     JOIN users u ON u.id = dm.sender_id
     LEFT JOIN dm_unread un ON un.user_id = dm.recipient_id AND un.from_user_id = dm.sender_id
     WHERE dm.id IN (
       SELECT MAX(id) FROM direct_messages
       WHERE recipient_id = ? AND sender_id != ? AND system IS NULL AND timestamp >= ?
       GROUP BY sender_id
     )
     ORDER BY dm.id DESC`,
    [userId, userId, from]
  );
  const me = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
  const entries = [];
  for (const row of rows) {
    if (blocked.has(row.sender_id) || await isConversationMuted(userId, 'dm', row.sender_id)) continue;
    entries.push({
      id: `dm-${row.id}`,
      unread: Boolean(row.unread),
      payload: buildDmPushPayload(row, await getUserImageUrl(row.sender_id), me?.username),
    });
  }
  return entries;
}

async function groupEntries(userId, blocked, from) {
  const blockedList = [...blocked];
  const rows = await db.all(
    `SELECT m.id, m.group_id, m.epoch, m.sender_id, m.content, m.timestamp, m.parent_message_id,
       u.username AS sender_username,
       m.id > COALESCE(r.last_read_id, 0) AS unread
     FROM group_dm_messages m
     JOIN users u ON u.id = m.sender_id
     LEFT JOIN group_dm_reads r ON r.group_id = m.group_id AND r.user_id = ?
     WHERE m.id IN (
       SELECT MAX(gm.id) FROM group_dm_messages gm
       JOIN group_dm_members mem ON mem.group_id = gm.group_id AND mem.user_id = ?
       JOIN group_dm_epoch_keys k ON k.group_id = gm.group_id AND k.epoch = gm.epoch AND k.user_id = ?
       WHERE gm.sender_id != ? AND gm.system IS NULL AND gm.timestamp >= ?
         ${blockedList.length ? `AND gm.sender_id NOT IN (${blockedList.map(() => '?').join(',')})` : ''}
       GROUP BY gm.group_id
     )
     ORDER BY m.id DESC`,
    [userId, userId, userId, userId, from, ...blockedList]
  );
  const entries = [];
  for (const row of rows) {
    if (await isConversationMuted(userId, 'group', row.group_id)) continue;
    const senderName = await displayNameOf(row.sender_id, row.sender_username);
    entries.push({
      id: `group-${row.id}`,
      unread: Boolean(row.unread),
      payload: await buildGroupPushPayload(row.group_id, row, userId, senderName),
    });
  }
  return entries;
}

async function botDmEntries(userId, blocked, from) {
  const rows = await db.all(
    `SELECT m.id, m.content, m.embeds, m.attachments, m.timestamp, d.id AS dm_id, d.bot_id,
       u.username AS sender_username, u.display_name AS sender_display_name,
       m.id > COALESCE(d.read_id, 0) AS unread
     FROM bot_dm_messages m
     JOIN bot_dms d ON d.id = m.dm_id
     JOIN users u ON u.id = m.sender_id
     WHERE m.id IN (
       SELECT MAX(bm.id) FROM bot_dm_messages bm JOIN bot_dms bd ON bd.id = bm.dm_id
       WHERE bd.user_id = ? AND bm.sender_id != ? AND bm.timestamp >= ?
       GROUP BY bm.dm_id
     )
     ORDER BY m.id DESC`,
    [userId, userId, from]
  );
  const entries = [];
  for (const row of rows) {
    if (blocked.has(row.bot_id) || await isConversationMuted(userId, 'bot', row.dm_id)) continue;
    // As botDms.js notifyPerson words it.
    const embeds = parseJsonList(row.embeds);
    const files = parseJsonList(row.attachments);
    const body = row.content || embeds[0]?.title || embeds[0]?.description || (files.length ? files[0].filename : '');
    entries.push({
      id: `bot-${row.id}`,
      unread: Boolean(row.unread),
      payload: {
        type: 'bot_dm',
        title: row.sender_display_name || row.sender_username,
        body: String(body).slice(0, 300),
        url: `/dm/b/${row.dm_id}`,
        tag: `bot-dm-${row.dm_id}`,
        senderId: row.bot_id,
        image: await getUserImageUrl(row.bot_id),
        timestamp: row.timestamp,
      },
    });
  }
  return entries;
}

async function guildEntries(userId, blocked, blockedWebhooks, from) {
  const rows = await db.all(
    `SELECT m.id, m.channel_id, m.sender_id, m.content, m.timestamp, m.document_id, m.webhook_id,
       m.webhook_avatar, m.embeds, m.attachments,
       COALESCE(u.username, m.webhook_name) AS sender_username, u.display_name AS sender_display_name,
       m.id > COALESCE(r.last_read_id, 0) AS unread
     FROM guild_messages m
     LEFT JOIN users u ON u.id = m.sender_id
     LEFT JOIN guild_channel_reads r ON r.channel_id = m.channel_id AND r.user_id = ?
     WHERE m.timestamp >= ? AND m.sender_id != ? AND m.system IS NULL AND (
       m.id IN (SELECT message_id FROM guild_mentions WHERE user_id = ?)
       OR m.parent_message_id IN (SELECT id FROM guild_messages WHERE sender_id = ?)
     )
     ORDER BY m.id DESC LIMIT ?`,
    [userId, from, userId, userId, userId, INBOX_LIMIT * 2]
  );
  const channels = new Map();
  const guildNames = new Map();
  const entries = [];
  for (const row of rows) {
    if (row.sender_id ? blocked.has(row.sender_id) : blockedWebhooks.has(row.webhook_id)) continue;
    if (!channels.has(row.channel_id)) {
      const access = await getChannelAccess(row.channel_id, userId);
      channels.set(row.channel_id, access && has(access.permissions, PERMISSIONS.VIEW_CHANNEL) && await levelOf(userId, access) !== 'none'
        ? access.channel : null);
    }
    const channel = channels.get(row.channel_id);
    if (!channel) continue;
    if (!guildNames.has(channel.guild_id)) {
      guildNames.set(channel.guild_id, (await db.get('SELECT name FROM guilds WHERE id = ?', [channel.guild_id]))?.name ?? '');
    }
    const payload = await channelPushPayload(row, channel, guildNames.get(channel.guild_id));
    const embed = parseJsonList(row.embeds).find((e) => e.title || e.description);
    const file = parseJsonList(row.attachments)[0];
    const body = (await previewText(row.content, channel.guild_id))
      || (embed ? String(embed.title || embed.description) : file ? `📎 ${file.filename}` : '');
    entries.push({
      id: `guild-${row.id}`,
      unread: Boolean(row.unread),
      payload: { ...payload, body, guildId: channel.guild_id, messageId: row.id, senderId: row.sender_id || null },
    });
  }
  return entries;
}

// Your notification level where the channel is (as mentions.js pushRecipients works it out):
// the channel's, a thread's channel's, else the guild's.
async function levelOf(userId, { channel }) {
  const ids = [channel.id, channel.parent_id].filter(Boolean);
  const rows = await db.all(
    `SELECT channel_id, level FROM guild_channel_notify WHERE user_id = ? AND channel_id IN (${ids.map(() => '?').join(',')})`,
    [userId, ...ids]
  );
  const of = (id) => rows.find((r) => r.channel_id === id)?.level;
  const member = await db.get('SELECT notify_level FROM guild_members WHERE guild_id = ? AND user_id = ?', [channel.guild_id, userId]);
  return of(channel.id) ?? (channel.parent_id ? of(channel.parent_id) : undefined) ?? member?.notify_level ?? 'mentions';
}

// Newest first: [{ id, unread, payload }], at most INBOX_LIMIT. (Each kind comes newest first,
// so within a second the sort, which is stable, keeps that order.)
async function inboxFor(userId) {
  const blocks = await blockList(userId);
  const blocked = new Set(blocks.blocked);
  const blockedWebhooks = new Set(blocks.webhooks.map((w) => w.id));
  const from = since();
  const parts = await Promise.all([
    dmEntries(userId, blocked, from),
    groupEntries(userId, blocked, from),
    botDmEntries(userId, blocked, from),
    guildEntries(userId, blocked, blockedWebhooks, from),
  ]);
  return parts.flat()
    .sort((a, b) => b.payload.timestamp - a.payload.timestamp)
    .slice(0, INBOX_LIMIT);
}

module.exports = { INBOX_DAYS, INBOX_LIMIT, inboxFor };
