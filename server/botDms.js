const db = require('./db');
const D = require('./discord');
const { sendToUserSockets, isViewingConversation } = require('./sockets');
const { blockedBetween } = require('./blocks');
const { getPreferences } = require('./preferences');
const { isConversationMuted } = require('./conversationSettings');
const { sendPushToUser, getUserImageUrl } = require('./push');
const { parseJsonList } = require('./routes/guildMessages');

// Bot DMs (docs/bots.md): a direct conversation between a bot and one person, as Discord's DM
// channels (type 1). They are NOT end-to-end encrypted: bots have no keys, so these messages are
// plain text on the server, like a guild's, and the app says so on the conversation. Encrypted
// DMs, group DMs and calls stay out of bots' reach.
// - A bot opens one (bot API `POST /users/@me/channels`) only with someone it shares a guild
//   with, who hasn't blocked it and hasn't turned off Settings → Privacy → Direct messages from
//   bots (preferences.js `botDms`), and while it still exists. The same holds
//   for every message after, either way. The person can start one from a bot's profile too.
// - The person can delete the whole conversation (gone for the bot too); it also goes with
//   their account or the application. The bot can delete only its own messages.
// - Messages: content, embeds and files like a bot's guild messages (botMessages.js), no
//   components, reactions, pins, replies or threads (yet). The person writes plain text.
// - The bot gets MESSAGE_CREATE / _UPDATE / _DELETE with the Direct Messages intent (gateway.js);
//   the person gets `bot_dm_*` events and a push (`bot_dm`) unless they're looking or muted it.
// - Ids: the app's are the rows'; the bot API's are offset (CHANNEL_BASE, MESSAGE_BASE) so a DM
//   channel never has a guild channel's id, nor a DM message a guild message's.

const CHANNEL_BASE = 2 ** 41;
const MESSAGE_BASE = 2 ** 42;
const MAX_PERSON_MESSAGE = 2000; // Discord's
const PAGE = 50;

const now = () => Math.floor(Date.now() / 1000);
const isDmChannelId = (value) => {
  const n = D.ourId(value);
  return n != null && n > CHANNEL_BASE && n < MESSAGE_BASE;
};
const apiChannelId = (dmId) => String(CHANNEL_BASE + dmId);
const dmIdFromApi = (value) => D.ourId(value) - CHANNEL_BASE;
const apiMessageId = (id) => String(MESSAGE_BASE + id);
const messageIdFromApi = (value) => {
  const n = D.ourId(value);
  return n != null && n > MESSAGE_BASE ? n - MESSAGE_BASE : null;
};

class BotDmError extends Error {
  constructor(status, message, code = 50007) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---- Who may talk ----

// Throws BotDmError unless bot `botId` and person `userId` may message each other now.
async function checkAllowed(botId, userId) {
  const user = await db.get('SELECT id, bot, deleted_at, suspended_at, pending FROM users WHERE id = ?', [userId]);
  if (!user || user.bot || user.deleted_at || user.suspended_at || user.pending) {
    throw new BotDmError(403, 'Cannot send messages to this user');
  }
  const bot = await db.get('SELECT a.id FROM bot_applications a JOIN users u ON u.id = a.id WHERE a.id = ? AND u.deleted_at IS NULL', [botId]);
  if (!bot) throw new BotDmError(403, 'This bot no longer exists');
  const shared = await db.get(
    'SELECT 1 FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = ?',
    [botId, userId]
  );
  if (!shared) throw new BotDmError(403, 'Cannot send messages to this user: you share no guild');
  if (await blockedBetween(botId, userId)) throw new BotDmError(403, 'Cannot send messages to this user');
  if (!(await getPreferences(userId)).botDms) throw new BotDmError(403, 'Cannot send messages to this user: they have turned off messages from bots');
}

// ---- Conversations ----

// The conversation between `botId` and `userId`, made if there's none.
async function openDm(botId, userId) {
  await db.run('INSERT OR IGNORE INTO bot_dms (bot_id, user_id, created_at) VALUES (?, ?, ?)', [botId, userId, now()]);
  return db.get('SELECT * FROM bot_dms WHERE bot_id = ? AND user_id = ?', [botId, userId]);
}

const getDm = (id) => db.get('SELECT * FROM bot_dms WHERE id = ?', [id]);

// The person's conversations, newest first, as the DM list wants them.
async function listForUser(userId) {
  const rows = await db.all(
    `SELECT d.id, d.bot_id, d.created_at, d.last_message_at, d.read_id,
       u.username AS bot_username, u.display_name AS bot_display_name, u.avatar AS bot_avatar,
       (SELECT COUNT(*) FROM bot_dm_messages m WHERE m.dm_id = d.id AND m.id > d.read_id AND m.sender_id != d.user_id) AS unread,
       (SELECT MAX(timestamp) FROM bot_dm_messages m WHERE m.dm_id = d.id AND m.id > d.read_id AND m.sender_id != d.user_id) AS last_unread_timestamp
     FROM bot_dms d JOIN users u ON u.id = d.bot_id WHERE d.user_id = ? ORDER BY COALESCE(d.last_message_at, d.created_at) DESC`,
    [userId]
  );
  return rows.map(summary);
}

function summary(row) {
  return {
    id: row.id,
    bot_id: row.bot_id,
    // The bot's profile, for drawing it (the app may not have it otherwise).
    bot: { id: row.bot_id, username: row.bot_username, display_name: row.bot_display_name, avatar: row.bot_avatar, bot: 1 },
    last_timestamp: row.last_message_at ?? row.created_at,
    unread: row.unread ?? 0,
    last_unread_sender_id: row.unread ? row.bot_id : null,
    last_unread_timestamp: row.last_unread_timestamp ?? null,
  };
}

// ---- Messages ----

// A row as the app has it (what ChatPane reads: `plaintext`, sender, embeds, attachments).
function appMessage(row) {
  return {
    id: row.id,
    dm_id: row.dm_id,
    sender_id: row.sender_id,
    sender_username: row.sender_username,
    sender_display_name: row.sender_display_name,
    content: row.content,
    plaintext: row.content,
    timestamp: row.timestamp,
    edited: row.edited_at ? 1 : 0,
    edited_at: row.edited_at,
    embeds: parseJsonList(row.embeds),
    attachments: parseJsonList(row.attachments),
    flags: row.flags,
    reactions: [],
  };
}

const SELECT = `SELECT m.*, u.username AS sender_username, u.display_name AS sender_display_name
  FROM bot_dm_messages m LEFT JOIN users u ON u.id = m.sender_id`;

// A page of a conversation's messages, oldest first: before/after ids (ours), up to `limit`.
async function listMessages(dmId, { before = null, after = null, limit = PAGE } = {}) {
  const max = Math.min(Math.max(Number(limit) || PAGE, 1), 100);
  if (after != null) {
    return db.all(`${SELECT} WHERE m.dm_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`, [dmId, after, max]);
  }
  const rows = await db.all(
    `${SELECT} WHERE m.dm_id = ?${before != null ? ' AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`,
    before != null ? [dmId, before, max] : [dmId, max]
  );
  return rows.reverse();
}

const getMessage = (dmId, id) => db.get(`${SELECT} WHERE m.dm_id = ? AND m.id = ?`, [dmId, id]);

// Discord's message objects for rows of DM `dm`.
async function apiMessages(rows, botId) {
  const shaped = rows.map((row) => ({
    id: MESSAGE_BASE + row.id,
    channel_id: CHANNEL_BASE + row.dm_id,
    sender_id: row.sender_id,
    sender_username: row.sender_username,
    sender_display_name: row.sender_display_name,
    content: row.content,
    timestamp: row.timestamp,
    edited: row.edited_at ? 1 : 0,
    edited_at: row.edited_at,
    embeds: parseJsonList(row.embeds),
    attachments: parseJsonList(row.attachments),
    flags: row.flags,
    components: [],
    reactions: [],
  }));
  return D.messageObjects(shaped, { botId, references: false });
}

// Discord's DM channel object.
async function apiChannel(dm) {
  const user = await db.get(`SELECT ${D.USER_COLUMNS} FROM users u WHERE u.id = ?`, [dm.user_id]);
  const last = await db.get('SELECT MAX(id) AS id FROM bot_dm_messages WHERE dm_id = ?', [dm.id]);
  return {
    id: apiChannelId(dm.id),
    type: 1,
    last_message_id: last?.id ? apiMessageId(last.id) : null,
    flags: 0,
    recipients: [D.userObject(user)],
  };
}

// Tells both sides: the person's app, and the bot's gateway sessions (gateway.js).
function announce(dm, event) {
  sendToUserSockets(dm.user_id, event);
  sendToUserSockets(dm.bot_id, event);
}

// A new message in `dm` from `senderId` (the bot or the person). `parts` is botMessages'
// { content, embeds, attachments, flags } (the person's: content only). Checks they may still
// talk. Resolves to the stored row.
async function createMessage(dm, senderId, parts) {
  await checkAllowed(dm.bot_id, dm.user_id);
  const { linkUploads, guildMessageKeys } = require('./uploads');
  const jsonOrNull = (list) => (list?.length ? JSON.stringify(list) : null);
  const timestamp = now();
  const id = await db.transaction(async () => {
    const { lastID } = await db.run(
      'INSERT INTO bot_dm_messages (dm_id, sender_id, content, timestamp, embeds, attachments, flags) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [dm.id, senderId, parts.content ?? '', timestamp, jsonOrNull(parts.embeds), jsonOrNull(parts.attachments), parts.flags ?? 0]
    );
    await db.run('UPDATE bot_dms SET last_message_at = ? WHERE id = ?', [timestamp, dm.id]);
    // Your own message reads the conversation up to it.
    if (senderId === dm.user_id) await db.run('UPDATE bot_dms SET read_id = ? WHERE id = ?', [lastID, dm.id]);
    const row = await db.get('SELECT * FROM bot_dm_messages WHERE id = ?', [lastID]);
    await linkUploads('bot_dm', lastID, guildMessageKeys(row));
    return lastID;
  });
  const row = await getMessage(dm.id, id);
  announce(dm, { type: 'bot_dm_message_new', dmId: dm.id, message: appMessage(row) });
  if (senderId === dm.bot_id) notifyPerson(dm, row);
  return row;
}

// A push for the person, unless they're looking at it or muted it.
async function notifyPerson(dm, row) {
  try {
    if (isViewingConversation(dm.user_id, `bot-dm-${dm.id}`)) return;
    if (await isConversationMuted(dm.user_id, 'bot', dm.id)) return;
    const embeds = parseJsonList(row.embeds);
    const files = parseJsonList(row.attachments);
    const body = row.content || embeds[0]?.title || embeds[0]?.description || (files.length ? files[0].filename : '');
    sendPushToUser(dm.user_id, {
      type: 'bot_dm',
      title: row.sender_display_name || row.sender_username,
      body: String(body).slice(0, 300),
      url: `/dm/b/${dm.id}`,
      tag: `bot-dm-${dm.id}`,
      image: await getUserImageUrl(dm.bot_id),
      timestamp: row.timestamp,
    }, { urgency: 'high', topic: `botdm${dm.id}` }).catch(() => {});
  } catch (err) {
    console.error('Bot DM push failed:', err.message);
  }
}

// Saves an edit (`parts` as createMessage's) of message `id`.
async function editMessage(dm, id, parts) {
  const { linkUploads, guildMessageKeys } = require('./uploads');
  const jsonOrNull = (list) => (list?.length ? JSON.stringify(list) : null);
  await db.transaction(async () => {
    await db.run(
      'UPDATE bot_dm_messages SET content = ?, embeds = ?, attachments = ?, flags = ?, edited_at = ? WHERE id = ? AND dm_id = ?',
      [parts.content ?? '', jsonOrNull(parts.embeds), jsonOrNull(parts.attachments), parts.flags ?? 0, now(), id, dm.id]
    );
    const row = await db.get('SELECT * FROM bot_dm_messages WHERE id = ?', [id]);
    await linkUploads('bot_dm', id, guildMessageKeys(row));
  });
  require('./uploads').releaseUploads();
  const row = await getMessage(dm.id, id);
  announce(dm, { type: 'bot_dm_message_edit', dmId: dm.id, message: appMessage(row) });
  return row;
}

async function deleteMessage(dm, id) {
  await db.transaction(async () => {
    await db.run('DELETE FROM bot_dm_messages WHERE id = ? AND dm_id = ?', [id, dm.id]);
    await db.run("DELETE FROM upload_refs WHERE kind = 'bot_dm' AND owner_id = ?", [id]);
  });
  require('./uploads').releaseUploads();
  announce(dm, { type: 'bot_dm_message_delete', dmId: dm.id, messageId: id });
}

// The person has read `dm` up to message `messageId` (never backwards), or with none (the DM
// list's Mark As Read) up to its newest.
async function markRead(dm, messageId) {
  const upTo = messageId == null
    ? (await db.get('SELECT COALESCE(MAX(id), 0) AS id FROM bot_dm_messages WHERE dm_id = ?', [dm.id])).id
    : Number(messageId) || 0;
  await db.run('UPDATE bot_dms SET read_id = MAX(read_id, ?) WHERE id = ?', [upTo, dm.id]);
  sendToUserSockets(dm.user_id, { type: 'bot_dm_read', dmId: dm.id });
}

// Deletes conversations (`where` on bot_dms) and their messages; inside the caller's transaction.
async function deleteWhere(where, params) {
  const ids = (await db.all(`SELECT id FROM bot_dms WHERE ${where}`, params)).map((r) => r.id);
  for (const id of ids) {
    await db.run("DELETE FROM upload_refs WHERE kind = 'bot_dm' AND owner_id IN (SELECT id FROM bot_dm_messages WHERE dm_id = ?)", [id]);
    await db.run('DELETE FROM bot_dm_messages WHERE dm_id = ?', [id]);
    await db.run("DELETE FROM conversation_settings WHERE kind = 'bot' AND target = ?", [String(id)]);
    await db.run('DELETE FROM bot_dms WHERE id = ?', [id]);
  }
  return ids;
}

// The person deletes the whole conversation: gone for the bot too.
async function deleteConversation(dm) {
  await db.transaction(() => deleteWhere('id = ?', [dm.id]));
  require('./uploads').releaseUploads();
  announce(dm, { type: 'bot_dm_delete', dmId: dm.id });
}

// With an account or an application (inside the caller's transaction).
const forgetUser = (userId) => deleteWhere('user_id = ?', [userId]);
const forgetBot = (botId) => deleteWhere('bot_id = ?', [botId]);

// The person's own text: trimmed of trailing space, 1 to 2000 characters. Null if not usable.
function cleanPersonText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+$/, '');
  return text.trim() && text.length <= MAX_PERSON_MESSAGE ? text : null;
}

module.exports = {
  CHANNEL_BASE,
  MESSAGE_BASE,
  MAX_PERSON_MESSAGE,
  BotDmError,
  isDmChannelId,
  apiChannelId,
  dmIdFromApi,
  apiMessageId,
  messageIdFromApi,
  checkAllowed,
  openDm,
  getDm,
  listForUser,
  summary,
  appMessage,
  listMessages,
  getMessage,
  apiMessages,
  apiChannel,
  createMessage,
  editMessage,
  deleteMessage,
  markRead,
  deleteConversation,
  forgetUser,
  forgetBot,
  cleanPersonText,
};
