const db = require('./db');
const { isViewingConversation } = require('./sockets');
const { isConversationMuted } = require('./conversationSettings');
const { getPreferences } = require('./preferences');
const { displayNameOf } = require('./profiles');
const { PERMISSIONS, has } = require('./permissions');
const { MAX_PUSH_CIPHERTEXT_LENGTH, sendPushToUser, sendToReactionApps, noteReactionShown, groupNameForPush, getUserImageUrl } = require('./push');

// Notifications when someone reacts to your message, as in Discord. Only the message's author
// is told, never about their own reactions, a reactor they blocked, a conversation they're
// looking at or have muted, or when their Settings → Notifications preference
// (`reactionNotifications`: 'all', 'dms', 'off') says not to. Taking a reaction back leaves the
// notification, as in Discord. No sound (the type isn't one of push.js MESSAGE_PUSHES).
//
// Guilds: the emoji is plain, so the server leaves out poll votes and words the push itself; it
// goes to every device, browsers too. Encrypted chats: the server can't tell a vote from an
// emoji, so the push carries the encrypted reaction for the device to open, and goes only to
// apps that drop what they shouldn't show (push.js sendToReactionApps), never to browsers.

// One push per person, message and reactor this often at most: taking one back and adding it
// again (or a few in a row) doesn't buzz each time. Each notification also replaces the last
// for that message (`tag`).
const REPEAT_MS = 30 * 1000;
const recent = new Map();

function tooSoon(key) {
  const now = Date.now();
  for (const [k, at] of recent) if (now - at >= REPEAT_MS) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

// A group message's ciphertext also travels with the group's encrypted name and the reaction.
const MAX_GROUP_MESSAGE_LENGTH = 1400;

async function wantsReactionPushes(userId, kind) {
  const { reactionNotifications } = await getPreferences(userId);
  return reactionNotifications === 'all' || (reactionNotifications === 'dms' && kind !== 'guild');
}

const blocked = async (authorId, reactorId) => (await require('./blocks').blockersAmong(reactorId, [authorId])).has(authorId);

// `message`: the DM ({ id, sender_id, recipient_id }); `reaction`: the row just added.
async function notifyDmReaction(message, reaction) {
  const authorId = message.sender_id;
  const reactorId = reaction.user_id;
  if (authorId === reactorId || message.recipient_id === authorId) return; // your own, or your notes
  if (isViewingConversation(authorId, reactorId)) return;
  if (!(await wantsReactionPushes(authorId, 'dm')) || await isConversationMuted(authorId, 'dm', reactorId)) return;
  if (await blocked(authorId, reactorId)) return;
  if (tooSoon(`dm:${message.id}:${reactorId}`)) return;

  const row = await db.get(
    `SELECT dm.content, r.username AS reactor_username, a.username AS author_username
     FROM direct_messages dm JOIN users r ON r.id = ? JOIN users a ON a.id = ? WHERE dm.id = ?`,
    [reactorId, authorId, message.id]
  );
  if (!row) return;
  const payload = {
    type: 'reaction',
    chat: 'dm',
    title: await displayNameOf(reactorId, row.reactor_username),
    // What's shown if the app can't open the reaction (it drops the push instead).
    body: 'Reacted to your message',
    url: `/dm/${reactorId}`,
    tag: `reaction-dm-${message.id}`,
    image: await getUserImageUrl(reactorId),
    timestamp: reaction.timestamp,
    messageId: message.id,
    reactorId,
    senderId: authorId,
    recipientId: message.recipient_id,
    authorName: row.author_username,
    reaction: reaction.content,
  };
  // The message itself for a preview, when it fits (decrypted like a DM push's).
  if (row.content.length <= MAX_PUSH_CIPHERTEXT_LENGTH - reaction.content.length) payload.ciphertext = row.content;
  const { delivered } = await sendToReactionApps(authorId, payload, { topic: `reaction${message.id}` });
  if (delivered) noteReactionShown(authorId, reactorId, payload.tag);
}

// `message`: the group message (routes/groupDms.js messageFor); `reaction`: the row just added.
async function notifyGroupReaction(message, reaction) {
  const authorId = message.sender_id;
  const reactorId = reaction.user_id;
  const groupId = message.group_id;
  if (authorId === reactorId) return;
  const groups = require('./groupDms');
  if (!(await groups.memberState(groupId, authorId))) return; // the author has left the group
  if (isViewingConversation(authorId, `group-${groupId}`)) return;
  if (!(await wantsReactionPushes(authorId, 'group')) || await isConversationMuted(authorId, 'group', groupId)) return;
  if (await blocked(authorId, reactorId)) return;
  if (tooSoon(`group:${message.id}:${reactorId}`)) return;

  const reactor = await db.get('SELECT username FROM users WHERE id = ?', [reactorId]);
  const reactorName = await displayNameOf(reactorId, reactor?.username);
  const payload = {
    type: 'reaction',
    chat: 'group',
    ...(await groupNameForPush(groupId)),
    body: `${reactorName} reacted to your message`,
    url: `/dm/g/${groupId}`,
    tag: `reaction-group-${message.id}`,
    image: await getUserImageUrl(reactorId),
    timestamp: reaction.timestamp,
    groupId,
    epoch: message.epoch,
    messageId: message.id,
    reactorId,
    reactorName,
    senderId: authorId,
    replyTo: message.parent_message_id ?? null,
    edited: Boolean(message.edited),
    reaction: reaction.content,
  };
  if (message.content && message.content.length <= MAX_GROUP_MESSAGE_LENGTH) payload.ciphertext = message.content;
  const { delivered } = await sendToReactionApps(authorId, payload, { topic: `reaction${message.id}` });
  if (delivered) noteReactionShown(authorId, `group-${groupId}`, payload.tag);
}

// `message` ({ id, sender_id, webhook_id }) in `channel` (guilds.js getChannelAccess); `emoji`
// isn't a poll's (votes and added answers never notify).
async function notifyGuildReaction(message, channel, reaction) {
  const authorId = message.sender_id;
  const reactorId = reaction.user_id;
  if (!authorId || message.webhook_id || authorId === reactorId) return;
  if (isViewingConversation(authorId, `channel-${channel.id}`)) return;
  if (!(await wantsReactionPushes(authorId, 'guild'))) return;

  // Their level for the channel (or its thread's channel, or the guild): 'none' is nothing at
  // all; a muted channel or guild too. Any other level counts, since the reaction is to them.
  const { getChannelAccess } = require('./guilds');
  const access = await getChannelAccess(channel.id, authorId);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return;
  const { mutedUserIds, guildMutedUserIds, channelLevels } = require('./channelMutes');
  const thread = channel.type === 'thread';
  const level = (await channelLevels(channel.id)).get(authorId)
    ?? (thread ? (await channelLevels(channel.parent_id)).get(authorId) : undefined)
    ?? (await db.get('SELECT notify_level FROM guild_members WHERE guild_id = ? AND user_id = ?', [channel.guild_id, authorId]))?.notify_level;
  if (level === 'none') return;
  if ((await mutedUserIds(channel.id)).has(authorId)) return;
  if (thread && (await mutedUserIds(channel.parent_id)).has(authorId)) return;
  if ((await guildMutedUserIds(channel.guild_id)).has(authorId)) return;
  if (await blocked(authorId, reactorId)) return;
  if (tooSoon(`guild:${message.id}:${reactorId}`)) return;

  const row = await db.get(
    `SELECT m.content, m.document_id, u.username, g.name AS guild_name
     FROM guild_messages m JOIN users u ON u.id = ? JOIN guilds g ON g.id = ? WHERE m.id = ?`,
    [reactorId, channel.guild_id, message.id]
  );
  if (!row) return;
  const { previewText } = require('./mentions');
  const reactorName = await displayNameOf(reactorId, row.username);
  const preview = await previewText(row.content ?? '', channel.guild_id);
  const where = thread ? `${channel.name}, #${channel.parent_name}` : `#${channel.name}`;
  // `<:name:id>` (a custom emoji) as :name: for text; apps draw it the same way.
  const emojiText = String(reaction.emoji).replace(/^<:([A-Za-z0-9_]+):\d+>$/, ':$1:');
  const { delivered } = await sendPushToUser(authorId, {
    type: 'reaction',
    chat: 'guild',
    title: `${reactorName} (${where}, ${row.guild_name})`,
    // What apps from before show; the app words it itself from the fields below.
    body: `Reacted ${emojiText} to your message${preview ? `: ${preview}` : ''}`,
    emoji: reaction.emoji,
    preview: preview || null,
    url: thread
      ? `/guild/${channel.guild_id}/${channel.parent_id}?thread=${channel.id}`
      : `/guild/${channel.guild_id}/${channel.id}${row.document_id ? `?doc=${row.document_id}` : ''}`,
    tag: `reaction-guild-${message.id}`,
    image: await getUserImageUrl(reactorId),
    timestamp: reaction.timestamp,
  }, { topic: `reaction${message.id}` });
  // Taken down once the channel is on one of their screens (push.js clearChatReactions).
  if (delivered) noteReactionShown(authorId, `channel-${channel.id}`, `reaction-guild-${message.id}`);
}

// Never fails what caused it: a reaction is saved whether or not anyone hears about it.
const quietly = (fn) => (...args) => fn(...args).catch((err) => console.error('Reaction push failed:', err.message));

module.exports = {
  notifyDmReaction: quietly(notifyDmReaction),
  notifyGroupReaction: quietly(notifyGroupReaction),
  notifyGuildReaction: quietly(notifyGuildReaction),
};
