const express = require('express');
const db = require('../db');
const { maxPlaintextLength } = require('../config');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has, channelPermissions } = require('../permissions');
const { getChannelAccess, getMember, getOverrides, sendToChannel, getChannelViewers } = require('../guilds');
const { saveMentions, notifyNewMessage, parseMentions } = require('../mentions');
const threads = require('../threads');
const { setPinned } = require('../pins');
const { POLL_VOTE, parsePoll, isClosedPoll, pollEditError, reactionIdsFor, pollReactionsFor } = require('../polls');
const { removePollRows } = require('../pollTimers');
const { releaseUploads } = require('../uploads');
const { logAudit } = require('../auditLog');
const { parseDuration, listMutes, setMute, CHANNEL_NOTIFY_LEVELS, listChannelLevels, setChannelLevel } = require('../channelMutes');
const { sendToUserSockets } = require('../sockets');
const { ActionError, withActionErrors } = require('../actionError');
const { refreshLinkPreviews } = require('../linkPreviews');

// Messages in guild text channels: plain text (guilds aren't end-to-end encrypted), in the
// same shape as DMs (sender_*, parent_*) so the client's message list shows both. Reading
// needs View Channel (without it the channel doesn't exist, 404), posting Send Messages,
// reacting Add Reactions. Authors edit their own; authors or Manage Messages delete. Events
// only go to the members who can see the channel. Mentions and pushes: see mentions.js.
const router = express.Router();

const MAX_REACTIONS_PER_USER_PER_MESSAGE = 20;
const MAX_EMOJI_LENGTH = 64;

// A webhook's messages (routes/webhooks.js) have sender_id 0 and no user: their name is
// `webhook_name` (also as sender_username) and their picture `webhook_avatar` (a URL or null).
const MESSAGE_SELECT = `
  SELECT
    m.id, m.channel_id, m.sender_id, m.content, m.timestamp, m.parent_message_id, m.edited,
    m.mention_everyone, m.mention_roles, m.pinned_at, m.pinned_by, m.system, m.document_id,
    m.webhook_id, m.webhook_name, m.webhook_avatar, m.embeds, m.attachments, m.flags, m.edited_at,
    m.components, m.interaction, m.link_embeds,
    COALESCE(u.username, m.webhook_name) AS sender_username,
    u.display_name AS sender_display_name,
    u.avatar AS sender_avatar,
    u.bot AS sender_bot,
    pm.content AS parent_content,
    pm.timestamp AS parent_timestamp,
    pu.id AS parent_sender_id,
    COALESCE(pu.username, pm.webhook_name) AS parent_username
  FROM guild_messages m
  LEFT JOIN users u ON m.sender_id = u.id
  LEFT JOIN guild_messages pm ON m.parent_message_id = pm.id
  LEFT JOIN users pu ON pm.sender_id = pu.id`;

// Adds `reactions` ([{ id, user_id, emoji, timestamp }], oldest first) to each message, and
// makes `mention_roles` (the roles it pinged), `embeds` and `attachments` arrays. A message a
// thread started from gets `thread` (threads.js; null otherwise).
async function withReactions(messages) {
  if (messages.length === 0) return messages;
  const ids = reactionIdsFor(messages);
  const threadsByMessage = await threads.threadsByStarter(messages.map((m) => m.id));
  const rows = await db.all(
    `SELECT id, message_id, user_id, emoji, timestamp FROM guild_reactions
     WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids
  );
  const byMessage = new Map(ids.map((id) => [id, []]));
  for (const { message_id: messageId, ...reaction } of rows) byMessage.get(messageId).push(reaction);
  return messages.map((m) => ({
    ...m,
    mention_roles: parseRoleIds(m.mention_roles),
    embeds: parseJsonList(m.embeds),
    link_embeds: parseJsonList(m.link_embeds),
    attachments: parseJsonList(m.attachments),
    components: parseJsonList(m.components),
    interaction: parseJsonObject(m.interaction),
    reactions: byMessage.get(m.id),
    thread: threadsByMessage.get(m.id) ?? null,
    ...pollReactionsFor(m, byMessage),
  }));
}

function parseJsonList(json) {
  try {
    const value = json ? JSON.parse(json) : [];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const parseRoleIds = parseJsonList;

function parseJsonObject(json) {
  try {
    const value = json ? JSON.parse(json) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const forbidden = (res) => res.status(403).json({ error: "You don't have permission to do that" });

// Text channels, threads (threads.js) and voice channels' chats: chats of plain messages.
const CHAT_TYPES = ['text', 'thread', 'voice'];
const isChat = (channel) => CHAT_TYPES.includes(channel.type);

// Loads req.channel and req.permissions (there) if the caller can see it and it's a text
// channel, a thread or a voice channel (its chat).
async function requireTextChannel(req, res, next) {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Channel not found' });
  if (!isChat(access.channel)) return res.status(400).json({ error: 'Not a text channel' });
  req.channel = access.channel;
  req.permissions = access.permissions;
  next();
}

// As requireTextChannel, but a document channel too: its messages are replies to one of its
// documents, whose id comes as `document` (query) or `documentId` (body) and is req.documentId
// (null in a text channel, where none may be given).
async function requireChatChannel(req, res, next) {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Channel not found' });
  const given = req.query.document ?? req.body?.documentId;
  if (isChat(access.channel)) {
    if (given != null) return res.status(400).json({ error: 'Not a document channel' });
    req.documentId = null;
  } else if (access.channel.type === 'doc') {
    const documentId = Number(given);
    const document = Number.isInteger(documentId) && await db.get(
      'SELECT id FROM guild_documents WHERE id = ? AND channel_id = ?',
      [documentId, access.channel.id]
    );
    if (!document) return res.status(404).json({ error: 'Document not found' });
    req.documentId = documentId;
  } else {
    return res.status(400).json({ error: 'Not a text channel' });
  }
  req.channel = access.channel;
  req.permissions = access.permissions;
  next();
}

// Marking read works for document channels too (the feed marks the whole channel read).
async function requireReadableChannel(req, res, next) {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Channel not found' });
  if (!isChat(access.channel) && access.channel.type !== 'doc') return res.status(400).json({ error: 'Not a text channel' });
  req.channel = access.channel;
  req.permissions = access.permissions;
  next();
}

// Loads req.message, its req.channel and req.permissions if the caller can see it.
async function requireMessage(req, res, next) {
  const messageId = Number(req.params.messageId);
  const message = Number.isInteger(messageId) && await db.get(
    'SELECT id, channel_id, sender_id, content, timestamp, system, webhook_id, webhook_name FROM guild_messages WHERE id = ?',
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

// A page of a channel (or of a document's replies, `document`), oldest first: the newest
// `limit` messages (1–100, default 50), or those before message id `before`.
router.get('/channels/:channelId/messages', authenticateJWT, requireChatChannel, async (req, res) => {
  const requestedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isNaN(requestedLimit) ? 50 : Math.min(Math.max(requestedLimit, 1), 100);
  const before = parseInt(req.query.before, 10);

  const params = [req.channel.id];
  let where = 'm.channel_id = ?';
  if (req.documentId) {
    where += ' AND m.document_id = ?';
    params.push(req.documentId);
  }
  if (!Number.isNaN(before)) {
    where += ' AND m.id < ?';
    params.push(before);
  }
  const rows = await db.all(`${MESSAGE_SELECT} WHERE ${where} ORDER BY m.id DESC LIMIT ?`, [...params, limit]);
  res.json(await withReactions(rows.reverse()));
});

// In a document channel, `documentId` says which document it replies to. In a thread (where
// Send Messages means Send Messages in Threads), posting unarchives it, and the sender and
// anyone mentioned by name join it.
router.post('/channels/:channelId/messages', authenticateJWT, requireChatChannel, async (req, res) => {
  if (!has(req.permissions, PERMISSIONS.SEND_MESSAGES)) return forbidden(res);
  const content = cleanContent(req.body?.content);
  if (!content) {
    return res.status(400).json({ error: `Messages are 1–${maxPlaintextLength} characters` });
  }

  // A reply must point at a message in this same channel (and document).
  let parentMessageId = null;
  if (req.body.replyTo != null) {
    parentMessageId = Number(req.body.replyTo);
    const parent = Number.isInteger(parentMessageId) && await db.get(
      'SELECT id FROM guild_messages WHERE id = ? AND channel_id = ? AND document_id IS ?',
      [parentMessageId, req.channel.id, req.documentId]
    );
    if (!parent) return res.status(400).json({ error: 'Invalid reply' });
  }

  const message = await createMessage({
    channel: req.channel,
    permissions: req.permissions,
    senderId: req.user.id,
    content,
    parentMessageId,
    documentId: req.documentId,
  });
  res.status(201).json(message);
});

// Saves and announces a message by `senderId` (who has `permissions` in `channel`; checked by
// the caller, as are the content and the reply) and sends its pushes. A bot's (routes/botApi.js)
// may have `embeds`, `attachments` and `components` (Discord's shapes), `flags`, `allowed`
// (allowed_mentions, as mentions.js takes it), `interaction` (the command it answers, see
// interactions.js) and `silent` (no pushes). Resolves to the message as the app has it.
async function createMessage({
  channel, permissions, senderId, content, parentMessageId = null, documentId = null,
  embeds = [], attachments = [], components = [], interaction = null, flags = 0, allowed, silent = false,
}) {
  const { lastID, mentions, joinedIds } = await db.transaction(async () => {
    const { lastID: id } = await db.run(
      `INSERT INTO guild_messages (channel_id, sender_id, content, parent_message_id, document_id, embeds, attachments, components, interaction, flags, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`,
      [channel.id, senderId, content, parentMessageId, documentId,
        embeds.length ? JSON.stringify(embeds) : null, attachments.length ? JSON.stringify(attachments) : null,
        components.length ? JSON.stringify(components) : null, interaction ? JSON.stringify(interaction) : null, flags]
    );
    await markRead(senderId, channel.id, id);
    await db.indexGuildMessage(id);
    const found = await saveMentions({ id, content, sender_id: senderId }, channel, permissions, allowed);
    const named = channel.type === 'thread'
      ? [...parseMentions(content).userIds].filter((userId) => found.mentioned.has(userId))
      : [];
    const joined = channel.type === 'thread' ? await threads.noteMessage(channel.id, senderId, named) : [];
    return { lastID: id, mentions: found, joinedIds: joined };
  });
  const [message] = await withReactions([await db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [lastID])]);

  await sendToChannel(channel, { type: 'guild_message_new', guildId: channel.guild_id, message });
  if (channel.type === 'thread') await threads.announceThread(channel.id, { joinedIds });
  notifyNewMessage(message, channel, mentions, { silent }).catch((err) => console.error('Guild push failed:', err.message));
  refreshLinkPreviews(message.id);
  return message;
}

// Only the author can edit. Mentions are worked out again (without pushes, like Discord).
router.put('/guild-messages/:messageId', authenticateJWT, requireMessage, async (req, res) => {
  if (req.message.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
  if (req.message.system) return res.status(403).json({ error: "This message can't be edited" });
  const content = cleanContent(req.body?.content);
  if (!content) {
    return res.status(400).json({ error: `Messages are 1–${maxPlaintextLength} characters` });
  }
  const pollError = pollEditError(req.message, content);
  if (pollError) return res.status(403).json({ error: pollError });
  await db.transaction(async () => {
    await db.run("UPDATE guild_messages SET content = ?, edited = 1, edited_at = strftime('%s','now') WHERE id = ?", [content, req.message.id]);
    await saveMentions({ id: req.message.id, content, sender_id: req.user.id }, req.channel, req.permissions);
    await db.indexGuildMessage(req.message.id);
  });
  releaseUploads();
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
  refreshLinkPreviews(req.message.id);
  res.json({ success: true, messageId: req.message.id, content });
});

// Discord's SUPPRESS_EMBEDS: "Remove previews" hides a message's embeds and link previews
// (`suppress: false` shows them again). Its author, or anyone with Manage Messages there.
const SUPPRESS_EMBEDS = 1 << 2;
router.put('/guild-messages/:messageId/suppress-embeds', authenticateJWT, requireMessage, async (req, res) => {
  if (req.message.sender_id !== req.user.id && !has(req.permissions, PERMISSIONS.MANAGE_MESSAGES)) return forbidden(res);
  const suppress = req.body?.suppress !== false;
  const { flags: old } = await db.get('SELECT flags FROM guild_messages WHERE id = ?', [req.message.id]);
  const flags = suppress ? old | SUPPRESS_EMBEDS : old & ~SUPPRESS_EMBEDS;
  if (flags !== old) {
    await db.run('UPDATE guild_messages SET flags = ? WHERE id = ?', [flags, req.message.id]);
    await sendToChannel(req.channel, {
      type: 'guild_message_embeds',
      guildId: req.channel.guild_id,
      channelId: req.channel.id,
      messageId: req.message.id,
      flags,
    });
  }
  res.json({ success: true, messageId: req.message.id, flags });
});

// The audit log entry for a message being deleted (by `actorId`, or its own webhook `webhookId`).
function logMessageDelete(message, channel, { actorId = null, webhookId = null }) {
  return logAudit({
    guildId: channel.guild_id,
    action: 'message_delete',
    actorId,
    webhookId,
    ...messageTarget(message),
    channelId: channel.id,
    details: {
      messageId: message.id,
      sentAt: message.timestamp,
      channelName: channel.name,
      ...(message.webhook_id ? { webhookName: message.webhook_name } : {}),
    },
  });
}

// Whose message it is, for the audit log: its author, or the webhook that posted it.
const messageTarget = (message) => (message.webhook_id
  ? { targetType: 'webhook', targetId: message.webhook_id }
  : { targetType: 'user', targetId: message.sender_id });

// The author, or anyone with Manage Messages there, can delete; its reactions go with it. It
// goes in the audit log (not "poll ended" rows, which go with their poll). `message` needs id,
// sender_id, system, timestamp and webhook_id/_name; `permissions` are `actorId`'s in `channel`.
// Shared with the bot API (routes/botApi.js). Throws ActionError.
async function deleteMessage(message, channel, actorId, permissions) {
  const { id, sender_id: senderId } = message;
  if (senderId !== actorId && !has(permissions, PERMISSIONS.MANAGE_MESSAGES)) {
    throw new ActionError(403, 'Not authorized to delete this message');
  }
  // A poll takes its "poll ended" row with it.
  const removed = await db.transaction(async () => {
    if (!message.system) await logMessageDelete(message, channel, { actorId });
    await db.run('DELETE FROM guild_reactions WHERE message_id = ?', [id]);
    await db.run('DELETE FROM guild_mentions WHERE message_id = ?', [id]);
    await db.run('DELETE FROM guild_messages WHERE id = ?', [id]);
    return removePollRows('guild', id);
  });
  releaseUploads();
  const { guild_id: guildId, id: channelId } = channel;
  for (const messageId of [id, ...removed]) {
    await sendToChannel(channel, { type: 'guild_message_delete', guildId, channelId, messageId });
  }
}

router.delete('/guild-messages/:messageId', authenticateJWT, requireMessage, withActionErrors(async (req, res) => {
  await deleteMessage(req.message, req.channel, req.user.id, req.permissions);
  res.json({ success: true, deletedId: req.message.id });
}));

// ---- Pins (Pin Messages in the channel) ----

// The channel's pinned messages, most recently pinned first.
router.get('/channels/:channelId/pins', authenticateJWT, requireTextChannel, async (req, res) => {
  const rows = await db.all(
    `${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC, m.id DESC`,
    [req.channel.id]
  );
  res.json(await withReactions(rows));
});

// Pins or unpins `message` for `actorId` (with `permissions` in `channel`). Only in text
// channels, threads and voice channels (a document channel's replies have no pinned list). Resolves to the pin
// ({ messageId, pinned_at, pinned_by }). Shared with the bot API. Throws ActionError.
async function setMessagePinned(message, channel, actorId, permissions, pinned) {
  if (!isChat(channel)) throw new ActionError(400, 'Not a text channel', 50024);
  if (!has(permissions, PERMISSIONS.PIN_MESSAGES)) throw new ActionError(403, "You don't have permission to do that");
  const { guild_id: guildId, id: channelId } = channel;
  const result = await setPinned('guild_messages', message.id, actorId, pinned, 'channel_id = ?', [channelId]);
  if (result.error) throw new ActionError(result.status, result.error, result.status === 400 ? 30003 : null);
  if (result.changed) {
    await logAudit({
      guildId,
      action: pinned ? 'message_pin' : 'message_unpin',
      actorId,
      ...messageTarget(message),
      channelId,
      details: { messageId: message.id, channelName: channel.name },
    });
  }
  const pin = { messageId: message.id, pinned_at: result.pinned_at, pinned_by: result.pinned_by };
  if (result.changed) await sendToChannel(channel, { type: 'guild_message_pin', guildId, channelId, ...pin });
  return pin;
}

const pinRoute = (pinned) => withActionErrors(async (req, res) => {
  res.json(await setMessagePinned(req.message, req.channel, req.user.id, req.permissions, pinned));
});

router.put('/guild-messages/:messageId/pin', authenticateJWT, requireMessage, pinRoute(true));
router.delete('/guild-messages/:messageId/pin', authenticateJWT, requireMessage, pinRoute(false));

// ---- Reactions (plain emoji) ----

// Adds `userId`'s reaction `emoji` to `message` (with id and content) in `channel`, where they
// have `permissions`. Resolves to the reaction row. Shared with the bot API. Throws ActionError.
async function addReaction(message, channel, userId, permissions, emoji) {
  if (typeof emoji !== 'string' || !emoji || emoji.length > MAX_EMOJI_LENGTH || /\s/.test(emoji)) {
    throw new ActionError(400, 'Invalid reaction', 10014);
  }
  // A poll's votes (see polls.js) only need to see the channel, not Add Reactions, and stop
  // when it closes.
  const vote = POLL_VOTE.test(emoji) && Boolean(parsePoll(message.content));
  if (vote && isClosedPoll(message)) throw new ActionError(403, 'This poll has closed');
  if (!vote && !has(permissions, PERMISSIONS.ADD_REACTIONS)) throw new ActionError(403, "You don't have permission to do that");
  const { guild_id: guildId, id: channelId } = channel;

  const { count } = await db.get(
    'SELECT COUNT(*) AS count FROM guild_reactions WHERE message_id = ? AND user_id = ?',
    [message.id, userId]
  );
  if (count >= MAX_REACTIONS_PER_USER_PER_MESSAGE) throw new ActionError(400, 'Too many reactions on this message', 30010);
  const { changes, lastID } = await db.run(
    'INSERT OR IGNORE INTO guild_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)',
    [message.id, userId, emoji]
  );
  if (!changes) throw new ActionError(409, 'Already reacted with that');

  const reaction = await db.get(
    'SELECT id, message_id, user_id, emoji, timestamp FROM guild_reactions WHERE id = ?',
    [lastID]
  );
  await sendToChannel(channel, { type: 'guild_reaction_add', guildId, channelId, reaction });
  return reaction;
}

router.post('/guild-messages/:messageId/reactions', authenticateJWT, requireMessage, withActionErrors(async (req, res) => {
  res.status(201).json(await addReaction(req.message, req.channel, req.user.id, req.permissions, req.body?.emoji));
}));

// Removes reaction `reaction` ({ id, message_id, user_id, emoji, content, timestamp }) from
// `channel`. A closed poll's votes are final. Whose it is is up to the caller.
async function removeReaction(reaction, channel) {
  if (POLL_VOTE.test(reaction.emoji) && isClosedPoll(reaction)) throw new ActionError(403, 'This poll has closed');
  await db.run('DELETE FROM guild_reactions WHERE id = ?', [reaction.id]);
  await sendToChannel(channel, {
    type: 'guild_reaction_remove',
    guildId: channel.guild_id,
    channelId: channel.id,
    messageId: reaction.message_id,
    reactionId: reaction.id,
    userId: reaction.user_id,
    emoji: reaction.emoji,
  });
}

// Only your own reactions can be removed.
router.delete('/guild-reactions/:reactionId', authenticateJWT, withActionErrors(async (req, res) => {
  const reactionId = Number(req.params.reactionId);
  const reaction = Number.isInteger(reactionId) && await db.get(
    `SELECT r.id, r.message_id, r.user_id, r.emoji, m.channel_id, m.content, m.timestamp FROM guild_reactions r
     JOIN guild_messages m ON m.id = r.message_id WHERE r.id = ?`,
    [reactionId]
  );
  const access = reaction && await getChannelAccess(reaction.channel_id, req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Reaction not found' });
  if (reaction.user_id !== req.user.id) return res.status(403).json({ error: 'Not your reaction' });
  await removeReaction(reaction, access.channel);
  res.json({ success: true });
}));

// Who can see a channel (text or voice): their user ids. For the member list and "@" suggestions.
router.get('/channels/:channelId/members', authenticateJWT, async (req, res) => {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Channel not found' });
  res.json(await getChannelViewers(access.channel));
});

// ---- Read state ----

// Marks the channel read up to `messageId` (never moves backwards), or with `latest: true` up
// to its newest message (document replies included; the channel list's Mark As Read).
router.post('/channels/:channelId/read', authenticateJWT, requireReadableChannel, async (req, res) => {
  const messageId = req.body?.latest === true
    ? (await db.get('SELECT MAX(id) AS id FROM guild_messages WHERE channel_id = ?', [req.channel.id])).id ?? 0
    : Number(req.body?.messageId);
  if (!Number.isInteger(messageId) || messageId < 0) return res.status(400).json({ error: 'Invalid messageId' });
  await markRead(req.user.id, req.channel.id, messageId);
  res.json({ success: true });
});

// Unread counts for every channel of the caller's guilds that has any and they can see:
// messages by other people after the caller's read marker (`count`), and how many of those
// mention them (`mentions`). Threads count only for their members.
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
     WHERE c.type != 'thread' OR EXISTS (SELECT 1 FROM guild_thread_members tm WHERE tm.thread_id = c.id AND tm.user_id = ?)
     GROUP BY c.id`,
    [me, me, me, me, me]
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

// Your muted channels (channelMutes.js): [{ channel_id, guild_id, until }].
router.get('/channel-mutes', authenticateJWT, async (req, res) => {
  res.json(await listMutes(req.user.id));
});

// Mutes a channel you can see for `duration` seconds, or until you unmute it (null or none);
// DELETE unmutes. Your other devices get `guild_channel_mute`.
async function changeMute(req, res, muted) {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Channel not found' });
  const duration = parseDuration(req.body?.duration);
  if (muted && duration === undefined) return res.status(400).json({ error: 'Invalid mute duration' });
  const mute = await setMute(req.user.id, access.channel.id, { muted, duration });
  const result = { guildId: access.channel.guild_id, channelId: access.channel.id, muted, until: mute?.until ?? null };
  sendToUserSockets(req.user.id, { type: 'guild_channel_mute', ...result });
  res.json(result);
}

router.put('/channels/:channelId/mute', authenticateJWT, (req, res) => changeMute(req, res, true));
router.delete('/channels/:channelId/mute', authenticateJWT, (req, res) => changeMute(req, res, false));

// Your own notification levels for channels (channelMutes.js): [{ channel_id, guild_id, level }].
router.get('/channel-notifications', authenticateJWT, async (req, res) => {
  res.json(await listChannelLevels(req.user.id));
});

// Sets your notification level for a channel you can see: 'all', 'mentions', 'none', or null
// for the guild's. Your other devices get `guild_channel_notify`.
router.put('/channels/:channelId/notifications', authenticateJWT, async (req, res) => {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Channel not found' });
  const level = req.body?.level ?? null;
  if (level !== null && !CHANNEL_NOTIFY_LEVELS.includes(level)) return res.status(400).json({ error: 'Invalid notification level' });
  await setChannelLevel(req.user.id, access.channel.id, level);
  const result = { guildId: access.channel.guild_id, channelId: access.channel.id, level };
  sendToUserSockets(req.user.id, { type: 'guild_channel_notify', ...result });
  res.json(result);
});

module.exports = router;
module.exports.MESSAGE_SELECT = MESSAGE_SELECT;
module.exports.withReactions = withReactions;
module.exports.parseJsonList = parseJsonList;
module.exports.logMessageDelete = logMessageDelete;
module.exports.messageTarget = messageTarget;
module.exports.markRead = markRead;
module.exports.createMessage = createMessage;
module.exports.deleteMessage = deleteMessage;
module.exports.setMessagePinned = setMessagePinned;
module.exports.addReaction = addReaction;
module.exports.removeReaction = removeReaction;
module.exports.MAX_REACTIONS_PER_USER_PER_MESSAGE = MAX_REACTIONS_PER_USER_PER_MESSAGE;
