// When polls close, and the "poll ended" row each gets in its chat (DMs, notes, group DMs and
// guild channels alike). A poll's author registers its end after sending it (`duration`
// seconds from the message's timestamp) and can end it early; a sweep posts the row once
// it's due, whether or not anyone is online.
//
// The row is a message with `system` = 'poll_end', the poll's author as sender, the poll as its
// parent and no content. Everything about the result stays on the devices: the row comes with
// the poll (still encrypted in DMs and groups, as a reply's parent does) and the poll's votes
// (`poll_reactions`, still encrypted), and each client works it out. So in encrypted chats the
// server learns only that a message is a poll and when it closes (plus who voted when, which it
// already saw as reactions), never the question, answers or result.
const db = require('./db');
const { sendToUserSockets } = require('./sockets');
const { POLL_END, parsePoll } = require('./polls');

const KINDS = {
  dm: { table: 'direct_messages', reactions: 'dm_reactions' },
  group: { table: 'group_dm_messages', reactions: 'group_dm_reactions' },
  guild: { table: 'guild_messages', reactions: 'guild_reactions' },
};
const MAX_DURATION = 14 * 86400;
const SWEEP_MS = 5000;
const STALE_SWEEP_MS = 60 * 60 * 1000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

class PollError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The poll message `messageId` of `kind`, if `userId` wrote it and can still see its chat.
async function authoredPoll(kind, messageId, userId) {
  const config = KINDS[kind];
  const message = config && Number.isInteger(messageId)
    && await db.get(`SELECT * FROM ${config.table} WHERE id = ?`, [messageId]);
  if (!message || message.system) throw new PollError(404, 'Message not found');
  if (message.sender_id !== userId) throw new PollError(403, 'Not your poll');
  if (kind === 'group') {
    const member = await db.get('SELECT 1 FROM group_dm_members WHERE group_id = ? AND user_id = ?', [message.group_id, userId]);
    if (!member) throw new PollError(404, 'Message not found');
  }
  if (kind === 'guild') {
    const { getChannelAccess } = require('./guilds');
    const { PERMISSIONS, has } = require('./permissions');
    const access = await getChannelAccess(message.channel_id, userId);
    if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) throw new PollError(404, 'Message not found');
    // Here the server reads the poll, so it has to be one.
    if (!parsePoll(message.content)) throw new PollError(400, 'Not a poll');
  }
  return message;
}

// Registers when poll `messageId` closes: `duration` s after it was sent. Only once.
async function registerPoll(kind, messageId, userId, duration) {
  const message = await authoredPoll(kind, messageId, userId);
  if (!Number.isInteger(duration) || duration <= 0 || duration > MAX_DURATION) throw new PollError(400, 'Invalid duration');
  if (kind === 'guild' && parsePoll(message.content).duration !== duration) {
    throw new PollError(400, "That isn't the poll's duration");
  }
  const endsAt = message.timestamp + duration;
  const { changes } = await db.run(
    'INSERT OR IGNORE INTO poll_timers (kind, message_id, ends_at) VALUES (?, ?, ?)',
    [kind, message.id, endsAt]
  );
  if (!changes) throw new PollError(409, 'Already registered');
  return { ends_at: endsAt };
}

// Its author ends poll `messageId` now: its row is posted at once.
async function endPollNow(kind, messageId, userId) {
  const message = await authoredPoll(kind, messageId, userId);
  if (kind === 'guild' && !parsePoll(message.content).endedAt) throw new PollError(400, 'End the poll first');
  const timer = await db.get('SELECT announced FROM poll_timers WHERE kind = ? AND message_id = ?', [kind, message.id]);
  if (timer?.announced) throw new PollError(409, 'The poll has already ended');
  await db.run(
    `INSERT INTO poll_timers (kind, message_id, ends_at) VALUES (?, ?, ?)
     ON CONFLICT(kind, message_id) DO UPDATE SET ends_at = MIN(ends_at, excluded.ends_at)`,
    [kind, message.id, nowSeconds()]
  );
  return announce(kind, message.id);
}

// Posts poll `messageId`'s "poll ended" row (once) and sends it to everyone in the chat.
// Returns the row's id, or null if there was nothing to post.
async function announce(kind, messageId) {
  const { table } = KINDS[kind];
  const id = await db.transaction(async () => {
    const timer = await db.get('SELECT announced FROM poll_timers WHERE kind = ? AND message_id = ?', [kind, messageId]);
    if (!timer || timer.announced) return null;
    await db.run('UPDATE poll_timers SET announced = 1 WHERE kind = ? AND message_id = ?', [kind, messageId]);
    const poll = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [messageId]);
    if (!poll) return null;
    const { lastID } = await insertRow(kind, poll);
    return lastID;
  });
  if (id) await deliver(kind, id);
  return id;
}

async function insertRow(kind, poll) {
  if (kind === 'dm') {
    const row = await db.run(
      `INSERT INTO direct_messages (sender_id, recipient_id, content, parent_message_id, system, timestamp)
       VALUES (?, ?, '', ?, ?, strftime('%s','now'))`,
      [poll.sender_id, poll.recipient_id, poll.id, POLL_END]
    );
    // Unread for the other person, like any message from the poll's author (not in notes).
    if (poll.recipient_id !== poll.sender_id) await db.run(
      `INSERT INTO dm_unread (user_id, from_user_id, count, first_unread_id) VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id, from_user_id) DO UPDATE SET count = count + 1`,
      [poll.recipient_id, poll.sender_id, row.lastID]
    );
    return row;
  }
  if (kind === 'group') {
    // In the poll's epoch, so exactly those who can read the poll get it.
    return db.run(
      `INSERT INTO group_dm_messages (group_id, epoch, sender_id, content, parent_message_id, system, timestamp)
       VALUES (?, ?, ?, '', ?, ?, strftime('%s','now'))`,
      [poll.group_id, poll.epoch, poll.sender_id, poll.id, POLL_END]
    );
  }
  // A poll in a document's replies gets its row there too.
  return db.run(
    `INSERT INTO guild_messages (channel_id, sender_id, content, parent_message_id, system, document_id, timestamp)
     VALUES (?, ?, '', ?, ?, ?, strftime('%s','now'))`,
    [poll.channel_id, poll.sender_id, poll.id, POLL_END, poll.document_id ?? null]
  );
}

// Sends a new system row ("poll ended", or a call: callLog.js) as the chat's usual
// new-message event (no pushes).
async function deliver(kind, id) {
  if (kind === 'dm') {
    const { loadMessage, sendToConversation } = require('./routes/dms');
    const message = await loadMessage(id);
    sendToConversation(message, { type: 'new_dm', message });
  } else if (kind === 'group') {
    const { messageFor } = require('./routes/groupDms');
    const { memberIds } = require('./groupDms');
    const { group_id: groupId } = await db.get('SELECT group_id FROM group_dm_messages WHERE id = ?', [id]);
    for (const userId of await memberIds(groupId)) {
      const message = await messageFor(userId, id);
      if (message) sendToUserSockets(userId, { type: 'group_dm_message_new', groupId, message });
    }
  } else {
    const { MESSAGE_SELECT, withReactions } = require('./routes/guildMessages');
    const { sendToChannel } = require('./guilds');
    const [message] = await withReactions([await db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [id])]);
    const channel = await db.get('SELECT * FROM guild_channels WHERE id = ?', [message.channel_id]);
    if (channel) await sendToChannel(channel, { type: 'guild_message_new', guildId: channel.guild_id, message });
  }
}

// Posts the rows of every poll that has closed since the last sweep.
async function announceDue() {
  const due = await db.all('SELECT kind, message_id FROM poll_timers WHERE announced = 0 AND ends_at <= ?', [nowSeconds()]);
  for (const { kind, message_id: messageId } of due) {
    try {
      await announce(kind, messageId);
    } catch (err) {
      console.error('Poll end failed:', err.message);
    }
  }
}

// Drops the timers of polls that are gone: deleting a whole chat (a guild, a channel, a group
// DM) doesn't go through removePollRows.
async function removeStaleTimers() {
  for (const [kind, { table }] of Object.entries(KINDS)) {
    await db.run(
      `DELETE FROM poll_timers WHERE kind = ? AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = poll_timers.message_id)`,
      [kind]
    );
  }
}

function startPollTimers() {
  announceDue();
  removeStaleTimers().catch((err) => console.error('Poll timer cleanup failed:', err.message));
  setInterval(() => removeStaleTimers().catch((err) => console.error('Poll timer cleanup failed:', err.message)), STALE_SWEEP_MS);
  return setInterval(announceDue, SWEEP_MS);
}

// A poll message is being deleted: its timer goes, and so does its "poll ended" row (with that
// row's reactions). Call inside the delete's transaction; returns the removed rows' ids, for
// the delete events.
async function removePollRows(kind, messageId) {
  const { table, reactions } = KINDS[kind];
  await db.run('DELETE FROM poll_timers WHERE kind = ? AND message_id = ?', [kind, messageId]);
  const rows = await db.all(`SELECT id FROM ${table} WHERE system = ? AND parent_message_id = ?`, [POLL_END, messageId]);
  for (const { id } of rows) {
    await db.run(`DELETE FROM ${reactions} WHERE message_id = ?`, [id]);
    await db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  }
  return rows.map((r) => r.id);
}

module.exports = { KINDS, PollError, registerPoll, endPollNow, announceDue, removeStaleTimers, startPollTimers, removePollRows, deliverRow: deliver };
