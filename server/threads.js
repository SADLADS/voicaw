const db = require('./db');
const { sendToUserSockets } = require('./sockets');
const { sendToChannel } = require('./guilds');

// Threads in guild text channels, like Discord's (docs/guilds.md, Threads). A thread is a
// guild_channels row of type 'thread' under its text channel (`parent_id`), so its messages,
// unread counts, mentions, mutes and typing work as in any channel; it has no permission
// overrides of its own (guilds.js getOverrides gives it its channel's). Each starts from a
// message in the channel (`starter_message_id`; one started on its own gets a "started a thread"
// row there, system 'thread'). Members (guild_thread_members) see it in their channel list.

const MAX_THREAD_NAME = 100;
// A thread nobody has written in for this long is archived (worked out when read, no timer).
const AUTO_ARCHIVE_SECONDS = 7 * 24 * 60 * 60;
// System row in the channel for a thread started on its own; its content is the thread's name.
const THREAD_ROW = 'thread';

const now = () => Math.floor(Date.now() / 1000);

// SQL for whether thread `t` is archived right now (by hand, or a week without activity).
const ARCHIVED_SQL = `(t.archived = 1 OR COALESCE(t.last_activity, t.created_at, 0) <= ?)`;

// A thread as the API returns it (with `joined` for `userId` when given).
const THREAD_SELECT = `
  SELECT t.id, t.guild_id, t.parent_id, t.name, t.owner_id, t.starter_message_id, t.created_at,
    t.last_activity, ${ARCHIVED_SQL} AS archived,
    (SELECT COUNT(*) FROM guild_messages m WHERE m.channel_id = t.id AND m.system IS NULL) AS message_count`;

function shape(row) {
  if (!row) return row;
  const thread = { ...row, archived: Boolean(row.archived) };
  if (row.joined !== undefined) thread.joined = Boolean(row.joined);
  return thread;
}

const joinedSql = (userId) => (userId == null
  ? ''
  : `, EXISTS (SELECT 1 FROM guild_thread_members tm WHERE tm.thread_id = t.id AND tm.user_id = ${Number(userId)}) AS joined`);

async function getThread(threadId, userId = null) {
  const row = await db.get(
    `${THREAD_SELECT}${joinedSql(userId)} FROM guild_channels t WHERE t.id = ? AND t.type = 'thread'`,
    [now() - AUTO_ARCHIVE_SECONDS, threadId]
  );
  return shape(row);
}

// The guild's threads that aren't archived (with `joined` for `userId`); guilds.js filters them
// by what the member can see.
async function activeThreads(guildId, userId) {
  const rows = await db.all(
    `${THREAD_SELECT}${joinedSql(userId)} FROM guild_channels t
     WHERE t.guild_id = ? AND t.type = 'thread' AND NOT ${ARCHIVED_SQL}
     ORDER BY t.last_activity DESC, t.id DESC`,
    [now() - AUTO_ARCHIVE_SECONDS, guildId, now() - AUTO_ARCHIVE_SECONDS]
  );
  return rows.map(shape);
}

// Every thread of a text channel, most recently active first (at most `limit`).
async function channelThreads(channelId, userId, limit = 200) {
  const rows = await db.all(
    `${THREAD_SELECT}${joinedSql(userId)} FROM guild_channels t
     WHERE t.parent_id = ? AND t.type = 'thread'
     ORDER BY COALESCE(t.last_activity, t.created_at) DESC, t.id DESC LIMIT ?`,
    [now() - AUTO_ARCHIVE_SECONDS, channelId, limit]
  );
  return rows.map(shape);
}

// The threads started from these messages, by message id (for their "N messages" line).
async function threadsByStarter(messageIds) {
  if (!messageIds.length) return new Map();
  const rows = await db.all(
    `${THREAD_SELECT} FROM guild_channels t
     WHERE t.type = 'thread' AND t.starter_message_id IN (${messageIds.map(() => '?').join(',')})`,
    [now() - AUTO_ARCHIVE_SECONDS, ...messageIds]
  );
  return new Map(rows.map((r) => [r.starter_message_id, shape(r)]));
}

// Adds `userId` to the thread's members; true if they weren't one.
async function addMember(threadId, userId) {
  const { changes } = await db.run(
    'INSERT OR IGNORE INTO guild_thread_members (thread_id, user_id, joined_at) VALUES (?, ?, ?)',
    [threadId, userId, now()]
  );
  return changes > 0;
}

async function removeMember(threadId, userId) {
  const { changes } = await db.run('DELETE FROM guild_thread_members WHERE thread_id = ? AND user_id = ?', [threadId, userId]);
  return changes > 0;
}

async function memberIds(threadId) {
  const rows = await db.all('SELECT user_id FROM guild_thread_members WHERE thread_id = ?', [threadId]);
  return new Set(rows.map((r) => r.user_id));
}

// A new message in thread `threadId` (inside its transaction): it's active again (unarchived),
// and the sender (and anyone it mentions by name, `mentionedIds`) become members. -> the ids of
// those who just joined.
async function noteMessage(threadId, senderId, mentionedIds = []) {
  await db.run('UPDATE guild_channels SET last_activity = ?, archived = 0 WHERE id = ?', [now(), threadId]);
  const joined = [];
  for (const userId of [senderId, ...mentionedIds]) {
    if (userId && await addMember(threadId, userId)) joined.push(userId);
  }
  return joined;
}

// Tells everyone who can see the thread's channel how it is now (`guild_thread_update`; their
// `joined` isn't in it), and `joinedIds` / `leftIds` that they joined or left
// (`guild_thread_member`, to their own devices).
async function announceThread(threadId, { joinedIds = [], leftIds = [] } = {}) {
  const thread = await getThread(threadId);
  if (!thread) return;
  await sendToChannel({ id: thread.parent_id, guild_id: thread.guild_id }, { type: 'guild_thread_update', guildId: thread.guild_id, thread });
  for (const [ids, joined] of [[joinedIds, true], [leftIds, false]]) {
    for (const userId of ids) {
      sendToUserSockets(userId, { type: 'guild_thread_member', guildId: thread.guild_id, threadId, joined });
    }
  }
}

module.exports = {
  MAX_THREAD_NAME,
  AUTO_ARCHIVE_SECONDS,
  THREAD_ROW,
  getThread,
  activeThreads,
  channelThreads,
  threadsByStarter,
  addMember,
  removeMember,
  memberIds,
  noteMessage,
  announceThread,
};
