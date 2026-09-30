const express = require('express');
const db = require('../db');
const { maxPlaintextLength } = require('../config');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has, channelPermissions } = require('../permissions');
const { getChannelAccess, getMember, getOverrides, sendToChannel, getChannelViewers } = require('../guilds');
const { saveMentions, notifyNewMessage } = require('../mentions');

// Messages in guild text channels: plain text (guilds aren't end-to-end encrypted), in the
// same shape as DMs (sender_*, parent_*) so the client's message list shows both. Reading
// needs View Channel (without it the channel doesn't exist, 404), posting Send Messages,
// reacting Add Reactions. Authors edit their own; authors or Manage Messages delete. Events
// only go to the members who can see the channel. Mentions and pushes: see mentions.js.
const router = express.Router();

const MAX_REACTIONS_PER_USER_PER_MESSAGE = 20;
const MAX_EMOJI_LENGTH = 64;

const MESSAGE_SELECT = `
  SELECT
    m.id, m.channel_id, m.sender_id, m.content, m.timestamp, m.parent_message_id, m.edited,
    m.mention_everyone, m.mention_roles,
    u.username AS sender_username,
    u.display_name AS sender_display_name,
    pm.content AS parent_content,
    pu.id AS parent_sender_id,
    pu.username AS parent_username
  FROM guild_messages m
  JOIN users u ON m.sender_id = u.id
  LEFT JOIN guild_messages pm ON m.parent_message_id = pm.id
  LEFT JOIN users pu ON pm.sender_id = pu.id`;

// Adds `reactions` ([{ id, user_id, emoji, timestamp }], oldest first) to each message, and
// makes `mention_roles` (the roles it pinged) an array.
async function withReactions(messages) {
  if (messages.length === 0) return messages;
  const ids = messages.map((m) => m.id);
  const rows = await db.all(
    `SELECT id, message_id, user_id, emoji, timestamp FROM guild_reactions
     WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids
  );
  const byMessage = new Map(ids.map((id) => [id, []]));
  for (const { message_id: messageId, ...reaction } of rows) byMessage.get(messageId).push(reaction);
  return messages.map((m) => ({ ...m, mention_roles: parseRoleIds(m.mention_roles), reactions: byMessage.get(m.id) }));
}

function parseRoleIds(json) {
  try {
    return json ? JSON.parse(json) : [];
  } catch {
    return [];
  }
}

const forbidden = (res) => res.status(403).json({ error: "You don't have permission to do that" });

// Loads req.channel and req.permissions (there) if the caller can see it and it's a text channel.
async function requireTextChannel(req, res, next) {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Channel not found' });
  if (access.channel.type !== 'text') return res.status(400).json({ error: 'Not a text channel' });
  req.channel = access.channel;
  req.permissions = access.permissions;
  next();
}

// Loads req.message, its req.channel and req.permissions if the caller can see it.
async function requireMessage(req, res, next) {
  const messageId = Number(req.params.messageId);
  const message = Number.isInteger(messageId) && await db.get(
    'SELECT id, channel_id, sender_id FROM guild_messages WHERE id = ?',
    [messageId]
  );
  const access = message && await getChannelAccess(message.channel_id, req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Message not found' });
  req.message = message;
  req.channel = access.channel;
  req.permissions = access.permissions;
  next();
}

// Checks message text; returns the trimmed text, or null.
function cleanContent(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  return trimmed && trimmed.length <= maxPlaintextLength ? trimmed : null;
}

async function markRead(userId, channelId, messageId) {
  await db.run(
    `INSERT INTO guild_channel_reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
    [userId, channelId, messageId]
  );
}

// A page of a channel, oldest first: the newest `limit` messages (1–100, default 50), or
// those before message id `before`.
router.get('/channels/:channelId/messages', authenticateJWT, requireTextChannel, async (req, res) => {
  const requestedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isNaN(requestedLimit) ? 50 : Math.min(Math.max(requestedLimit, 1), 100);
  const before = parseInt(req.query.before, 10);

  const params = [req.channel.id];
  let where = 'm.channel_id = ?';
  if (!Number.isNaN(before)) {
    where += ' AND m.id < ?';
    params.push(before);
  }
  const rows = await db.all(`${MESSAGE_SELECT} WHERE ${where} ORDER BY m.id DESC LIMIT ?`, [...params, limit]);
  res.json(await withReactions(rows.reverse()));
});

router.post('/channels/:channelId/messages', authenticateJWT, requireTextChannel, async (req, res) => {
  if (!has(req.permissions, PERMISSIONS.SEND_MESSAGES)) return forbidden(res);
  const content = cleanContent(req.body?.content);
  if (!content) {
    return res.status(400).json({ error: `Messages are 1–${maxPlaintextLength} characters` });
  }

  // A reply must point at a message in this same channel.
  let parentMessageId = null;
  if (req.body.replyTo != null) {
    parentMessageId = Number(req.body.replyTo);
    const parent = Number.isInteger(parentMessageId) && await db.get(
      'SELECT id FROM guild_messages WHERE id = ? AND channel_id = ?',
      [parentMessageId, req.channel.id]
    );
    if (!parent) return res.status(400).json({ error: 'Invalid reply' });
  }

  const { lastID } = await db.run(
    `INSERT INTO guild_messages (channel_id, sender_id, content, parent_message_id, timestamp)
     VALUES (?, ?, ?, ?, strftime('%s','now'))`,
    [req.channel.id, req.user.id, content, parentMessageId]
  );
  await markRead(req.user.id, req.channel.id, lastID);
  const mentions = await saveMentions({ id: lastID, content, sender_id: req.user.id }, req.channel, req.permissions);
  const [message] = await withReactions([await db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [lastID])]);

  await sendToChannel(req.channel, { type: 'guild_message_new', guildId: req.channel.guild_id, message });
  res.status(201).json(message);
  notifyNewMessage(message, req.channel, mentions).catch((err) => console.error('Guild push failed:', err.message));
});

// Only the author can edit. Mentions are worked out again (without pushes, like Discord).
router.put('/guild-messages/:messageId', authenticateJWT, requireMessage, async (req, res) => {
  if (req.message.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
  const content = cleanContent(req.body?.content);
  if (!content) {
    return res.status(400).json({ error: `Messages are 1–${maxPlaintextLength} characters` });
  }
  await db.run('UPDATE guild_messages SET content = ?, edited = 1 WHERE id = ?', [content, req.message.id]);
  await saveMentions({ id: req.message.id, content, sender_id: req.user.id }, req.channel, req.permissions);
  const saved = await db.get('SELECT mention_everyone, mention_roles FROM guild_messages WHERE id = ?', [req.message.id]);
  await sendToChannel(req.channel, {
    type: 'guild_message_edit',
    guildId: req.channel.guild_id,
    channelId: req.channel.id,
    messageId: req.message.id,
    content,
    mention_everyone: saved.mention_everyone,
    mention_roles: parseRoleIds(saved.mention_roles),
  });
  res.json({ success: true, messageId: req.message.id, content });
});

// The author, or anyone with Manage Messages there, can delete; its reactions go with it.
router.delete('/guild-messages/:messageId', authenticateJWT, requireMessage, async (req, res) => {
  const { id, sender_id: senderId } = req.message;
  if (senderId !== req.user.id && !has(req.permissions, PERMISSIONS.MANAGE_MESSAGES)) {
    return res.status(403).json({ error: 'Not authorized to delete this message' });
  }
  await db.run('DELETE FROM guild_reactions WHERE message_id = ?', [id]);
  await db.run('DELETE FROM guild_mentions WHERE message_id = ?', [id]);
  await db.run('DELETE FROM guild_messages WHERE id = ?', [id]);
  const { guild_id: guildId, id: channelId } = req.channel;
  await sendToChannel(req.channel, { type: 'guild_message_delete', guildId, channelId, messageId: id });
  res.json({ success: true, deletedId: id });
});

// ---- Reactions (plain emoji) ----

router.post('/guild-messages/:messageId/reactions', authenticateJWT, requireMessage, async (req, res) => {
  const { emoji } = req.body ?? {};
  if (typeof emoji !== 'string' || !emoji || emoji.length > MAX_EMOJI_LENGTH || /\s/.test(emoji)) {
    return res.status(400).json({ error: 'Invalid reaction' });
  }
  if (!has(req.permissions, PERMISSIONS.ADD_REACTIONS)) return forbidden(res);
  const messageId = req.message.id;
  const { guild_id: guildId, id: channelId } = req.channel;

  const { count } = await db.get(
    'SELECT COUNT(*) AS count FROM guild_reactions WHERE message_id = ? AND user_id = ?',
    [messageId, req.user.id]
  );
  if (count >= MAX_REACTIONS_PER_USER_PER_MESSAGE) {
    return res.status(400).json({ error: 'Too many reactions on this message' });
  }
  const { changes, lastID } = await db.run(
    'INSERT OR IGNORE INTO guild_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)',
    [messageId, req.user.id, emoji]
  );
  if (!changes) return res.status(409).json({ error: 'Already reacted with that' });

  const reaction = await db.get(
    'SELECT id, message_id, user_id, emoji, timestamp FROM guild_reactions WHERE id = ?',
    [lastID]
  );
  await sendToChannel(req.channel, { type: 'guild_reaction_add', guildId, channelId, reaction });
  res.status(201).json(reaction);
});

// Only your own reactions can be removed.
router.delete('/guild-reactions/:reactionId', authenticateJWT, async (req, res) => {
  const reactionId = Number(req.params.reactionId);
  const reaction = Number.isInteger(reactionId) && await db.get(
    `SELECT r.id, r.message_id, r.user_id, m.channel_id FROM guild_reactions r
     JOIN guild_messages m ON m.id = r.message_id WHERE r.id = ?`,
    [reactionId]
  );
  const access = reaction && await getChannelAccess(reaction.channel_id, req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Reaction not found' });
  if (reaction.user_id !== req.user.id) return res.status(403).json({ error: 'Not your reaction' });

  const { channel } = access;
  await db.run('DELETE FROM guild_reactions WHERE id = ?', [reactionId]);
  await sendToChannel(channel, {
    type: 'guild_reaction_remove',
    guildId: channel.guild_id,
    channelId: channel.id,
    messageId: reaction.message_id,
    reactionId,
  });
  res.json({ success: true });
});

// Who can see a channel (text or voice): their user ids. For the member list and "@" suggestions.
router.get('/channels/:channelId/members', authenticateJWT, async (req, res) => {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Channel not found' });
  res.json(await getChannelViewers(access.channel));
});

// ---- Read state ----

// Marks the channel read up to `messageId` (never moves backwards).
router.post('/channels/:channelId/read', authenticateJWT, requireTextChannel, async (req, res) => {
  const messageId = Number(req.body?.messageId);
  if (!Number.isInteger(messageId) || messageId < 0) return res.status(400).json({ error: 'Invalid messageId' });
  await markRead(req.user.id, req.channel.id, messageId);
  res.json({ success: true });
});

// Unread counts for every channel of the caller's guilds that has any and they can see:
// messages by other people after the caller's read marker (`count`), and how many of those
// mention them (`mentions`).
router.get('/guild-unread', authenticateJWT, async (req, res) => {
  const me = req.user.id;
  const rows = await db.all(
    `SELECT c.id AS channel_id, c.guild_id, COUNT(m.id) AS count,
       (SELECT COUNT(*) FROM guild_mentions gmn WHERE gmn.user_id = ? AND gmn.channel_id = c.id
          AND gmn.message_id > COALESCE(r.last_read_id, 0)) AS mentions
     FROM guild_channels c
     JOIN guild_members gm ON gm.guild_id = c.guild_id AND gm.user_id = ?
     LEFT JOIN guild_channel_reads r ON r.channel_id = c.id AND r.user_id = ?
     JOIN guild_messages m ON m.channel_id = c.id AND m.id > COALESCE(r.last_read_id, 0) AND m.sender_id != ?
     GROUP BY c.id`,
    [me, me, me, me]
  );
  const visible = [];
  for (const guildId of new Set(rows.map((r) => r.guild_id))) {
    const member = await getMember(guildId, me);
    const overrides = await getOverrides({ guildId });
    for (const row of rows.filter((r) => r.guild_id === guildId)) {
      if (has(channelPermissions(member, me, overrides.get(row.channel_id)), PERMISSIONS.VIEW_CHANNEL)) visible.push(row);
    }
  }
  res.json(visible);
});

module.exports = router;
