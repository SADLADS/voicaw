const db = require('./db');
const { isViewingConversation } = require('./sockets');
const { isConversationMuted } = require('./conversationSettings');
const { displayNameOf } = require('./profiles');
const {
  MAX_PUSH_CIPHERTEXT_LENGTH, sendPushToUser, groupNameForPush, getUserImageUrl,
} = require('./push');

// Notifications for two of the chats' system rows: "pinned a message" (pins.js) and "poll ended"
// (pollTimers.js). Both are messages in the chat (unread, tagged and cleared like one, with the
// Message sound), so they're pushed as the chat's own type (`dm`, `group`, `guild`) with
// `system` = 'pin' / 'poll_end' and the app words them (client services/pushNotifications.js).
//
// - A pin goes to everyone else in a DM or group, and in a guild channel to the pinned message's
//   author (as if mentioned) and whoever gets every message there.
// - A poll closing goes to its author and everyone who voted, in a guild also to whoever gets
//   every message there. In DMs and groups the server can't tell a vote from an emoji (on
//   purpose, see Polls), so "voted" there is "reacted to the poll".
//
// Both are always true as worded without the message ("Ann pinned a message", "Ann's poll has
// closed"), so unlike reactions they reach browsers too. In encrypted chats the pinned message
// or the poll rides along encrypted (`messageCiphertext`, not `ciphertext`, so apps from before
// don't show it as a new message) for the device to add its text or question when it opens.
// Nobody is told about a chat they're looking at or have muted, or by someone they blocked.

// What a group push's message may take, beside the group's encrypted name.
const MAX_GROUP_CIPHERTEXT_LENGTH = 1450;

const blockedBy = async (userId, actorId) => userId !== actorId
  && (await require('./blocks').blockersAmong(actorId, [userId])).has(userId);

const fits = (content, max) => (content && content.length <= max ? content : undefined);

// Who reacted to message `messageId` of `kind` (votes, in DMs and groups any reaction).
async function voterIds(kind, messageId) {
  if (kind === 'guild') {
    const rows = await db.all(
      "SELECT DISTINCT user_id FROM guild_reactions WHERE message_id = ? AND emoji LIKE 'poll:%' AND emoji NOT LIKE 'poll:+%' AND emoji NOT LIKE 'poll:-%'",
      [messageId]
    );
    return rows.map((r) => r.user_id);
  }
  const table = kind === 'dm' ? 'dm_reactions' : 'group_dm_reactions';
  return (await db.all(`SELECT DISTINCT user_id FROM ${table} WHERE message_id = ?`, [messageId])).map((r) => r.user_id);
}

// ---- DMs ----

// Row `rowId` (sender: the pinner or the poll's author) about `message` (the pinned message or
// the poll), pushed to `userId`, whose chat it is with `otherId`.
async function dmPush(userId, otherId, row, message, fields) {
  if (isViewingConversation(userId, otherId) || await isConversationMuted(userId, 'dm', otherId)) return;
  if (await blockedBy(userId, row.sender_id)) return;
  const [other, me] = await Promise.all([
    db.get('SELECT username FROM users WHERE id = ?', [otherId]),
    db.get('SELECT username FROM users WHERE id = ?', [userId]),
  ]);
  await sendPushToUser(userId, {
    type: 'dm',
    title: await displayNameOf(otherId, other?.username),
    url: `/dm/${otherId}`,
    tag: `dm-${otherId}`,
    image: await getUserImageUrl(otherId),
    timestamp: row.timestamp,
    senderId: otherId,
    recipientId: userId,
    recipientName: me?.username,
    // The message the row is about, opened with the conversation's key and its own two people.
    messageId: message.id,
    messageSenderId: message.sender_id,
    messageRecipientId: message.recipient_id,
    messageCiphertext: fits(message.content, MAX_PUSH_CIPHERTEXT_LENGTH),
    ...fields,
  }, { urgency: 'high', topic: `dm${otherId}` });
}

async function dmRow(rowId) {
  const row = await db.get('SELECT * FROM direct_messages WHERE id = ?', [rowId]);
  const message = row && await db.get('SELECT * FROM direct_messages WHERE id = ?', [row.parent_message_id]);
  return message ? { row, message } : null;
}

// ---- Group DMs ----

// The same in group `groupId`, if `userId` can read the message (its epoch).
async function groupPush(userId, row, message, fields) {
  const groupId = row.group_id;
  const readable = await db.get(
    'SELECT 1 FROM group_dm_epoch_keys WHERE group_id = ? AND epoch = ? AND user_id = ?',
    [groupId, message.epoch, userId]
  );
  if (!readable) return;
  if (isViewingConversation(userId, `group-${groupId}`) || await isConversationMuted(userId, 'group', groupId)) return;
  if (await blockedBy(userId, row.sender_id)) return;
  await sendPushToUser(userId, {
    type: 'group',
    ...(await groupNameForPush(groupId)),
    url: `/dm/g/${groupId}`,
    tag: `group-${groupId}`,
    image: await getUserImageUrl(row.sender_id),
    timestamp: row.timestamp,
    groupId,
    senderId: row.sender_id,
    senderName: fields.actorName,
    recipientId: userId,
    epoch: message.epoch,
    messageId: message.id,
    messageSenderId: message.sender_id,
    replyTo: message.parent_message_id ?? null,
    edited: Boolean(message.edited),
    messageCiphertext: fits(message.content, MAX_GROUP_CIPHERTEXT_LENGTH),
    ...fields,
  }, { urgency: 'high', topic: `group${groupId.replace(/-/g, '').slice(0, 20)}` });
}

async function groupRow(rowId) {
  const row = await db.get('SELECT * FROM group_dm_messages WHERE id = ?', [rowId]);
  const message = row && await db.get('SELECT * FROM group_dm_messages WHERE id = ?', [row.parent_message_id]);
  if (!message) return null;
  const members = (await db.all('SELECT user_id FROM group_dm_members WHERE group_id = ?', [row.group_id])).map((r) => r.user_id);
  return { row, message, members };
}

// ---- Guild channels ----

// Pushes row `rowId` (a message of `channel`) to `directed` (as if mentioned) and whoever gets
// every message there (mentions.js pushRecipients); `fieldsFor(userId)` -> the push's own fields.
async function channelPush(rowId, directed, fieldsFor, { sender = false } = {}) {
  const { MESSAGE_SELECT } = require('./routes/guildMessages');
  const { channelViewers, pushRecipients, channelPushPayload } = require('./mentions');
  const row = await db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [rowId]);
  const channel = row && await db.get(
    `SELECT c.*, p.name AS parent_name FROM guild_channels c LEFT JOIN guild_channels p ON p.id = c.parent_id WHERE c.id = ?`,
    [row.channel_id]
  );
  if (!channel) return;
  const viewers = await channelViewers(channel);
  const recipients = await pushRecipients(row, channel, viewers, new Set(directed.filter((id) => viewers.has(id))), { sender });
  if (!recipients.length) return;
  const guild = await db.get('SELECT name FROM guilds WHERE id = ?', [channel.guild_id]);
  const payload = await channelPushPayload(row, channel, guild.name);
  for (const userId of recipients) {
    await sendPushToUser(userId, { ...payload, ...fieldsFor(userId) }, { urgency: 'high', topic: `channel${channel.id}` });
  }
}

// ---- Pins ----

// English fallbacks, for apps from before (current ones word it themselves).
const pinnedBody = (name, text) => `${name ? `${name} pinned` : 'Pinned'} a message${text ? `: ${text}` : ''}`;

// "pinned a message" row `rowId` of `kind`, just posted.
async function notifyPinned(kind, rowId) {
  if (kind === 'dm') {
    const found = await dmRow(rowId);
    if (!found) return;
    const { row } = found;
    if (row.recipient_id === row.sender_id) return; // notes
    const actorName = await displayNameOf(row.sender_id);
    await dmPush(row.recipient_id, row.sender_id, row, found.message, { system: 'pin', actorName, body: pinnedBody() });
    return;
  }
  if (kind === 'group') {
    const found = await groupRow(rowId);
    if (!found) return;
    const { row, message, members } = found;
    const actorName = await displayNameOf(row.sender_id);
    for (const userId of members) {
      if (userId !== row.sender_id) await groupPush(userId, row, message, { system: 'pin', actorName, body: pinnedBody(actorName) });
    }
    return;
  }
  const row = await db.get(
    `SELECT m.sender_id, p.sender_id AS author_id, p.webhook_id, p.content, c.guild_id
     FROM guild_messages m JOIN guild_messages p ON p.id = m.parent_message_id JOIN guild_channels c ON c.id = m.channel_id
     WHERE m.id = ?`,
    [rowId]
  );
  if (!row) return;
  const { previewText } = require('./mentions');
  const preview = (await previewText(row.content ?? '', row.guild_id)) || null;
  const directed = row.author_id && !row.webhook_id && row.author_id !== row.sender_id ? [row.author_id] : [];
  const actorName = await displayNameOf(row.sender_id);
  await channelPush(rowId, directed, () => ({ system: 'pin', actorName, preview, body: pinnedBody(null, preview) }));
}

// ---- Polls ----

const pollBody = (mine, name, question) => `${mine ? 'Your' : `${name}'s`} poll ${question ? `“${question}” ` : ''}has closed`;

// "poll ended" row `rowId` of `kind`, just posted (its sender is the poll's author).
async function notifyPollEnded(kind, rowId) {
  if (kind === 'dm') {
    const found = await dmRow(rowId);
    if (!found) return;
    const { row, message } = found;
    const authorId = message.sender_id;
    const actorName = await displayNameOf(authorId);
    const recipients = new Set([authorId]);
    for (const id of await voterIds('dm', message.id)) if (id === message.recipient_id) recipients.add(id);
    for (const userId of recipients) {
      const mine = userId === authorId;
      const otherId = mine ? message.recipient_id : authorId;
      await dmPush(userId, otherId, row, message, { system: 'poll_end', actorName, mine, body: pollBody(mine, actorName) });
    }
    return;
  }
  if (kind === 'group') {
    const found = await groupRow(rowId);
    if (!found) return;
    const { row, message, members } = found;
    const actorName = await displayNameOf(row.sender_id);
    const voters = new Set(await voterIds('group', message.id));
    for (const userId of members) {
      const mine = userId === row.sender_id;
      if (mine || voters.has(userId)) {
        await groupPush(userId, row, message, { system: 'poll_end', actorName, mine, body: pollBody(mine, actorName) });
      }
    }
    return;
  }
  const row = await db.get('SELECT m.sender_id, p.id AS poll_id, p.content FROM guild_messages m JOIN guild_messages p ON p.id = m.parent_message_id WHERE m.id = ?', [rowId]);
  if (!row) return;
  const question = require('./polls').parsePoll(row.content)?.question ?? null;
  const actorName = await displayNameOf(row.sender_id);
  const directed = [row.sender_id, ...await voterIds('guild', row.poll_id)];
  await channelPush(rowId, directed, (userId) => {
    const mine = userId === row.sender_id;
    return { system: 'poll_end', actorName, mine, preview: question, body: pollBody(mine, actorName, question) };
  }, { sender: true });
}

// Never fails what caused it: the row is posted whether or not anyone hears about it.
const quietly = (fn) => (...args) => fn(...args).catch((err) => console.error('System row push failed:', err.message));

module.exports = { notifyPinned: quietly(notifyPinned), notifyPollEnded: quietly(notifyPollEnded) };
