const db = require('./db');

// Pinned messages, the same in DMs, group DMs and guild channels: a message's `pinned_at`
// (unix s) and `pinned_by`, null when it isn't pinned. Deleting a message takes its pin with it.
// Who may pin is up to each route (anyone in a DM or group, Pin Messages in a channel).
//
// Pinning also posts a "pinned a message" row in the chat, as Discord does: a message with
// `system` = 'pin', the pinner as sender, the pinned message as its parent and no content (so in
// encrypted chats it says nothing the server didn't already know: who pinned which message and
// when). Unpinning posts nothing. Deleting the pinned message deletes its rows
// (pollTimers.js removeLinkedRows).

// Per chat, as in Discord.
const MAX_PINS = 250;
const PIN_ROW = 'pin';

const KIND_OF = { direct_messages: 'dm', group_dm_messages: 'group', guild_messages: 'guild' };

// The "pinned a message" row for `message` (a row of `table`), pinned by `userId`. In a DM its
// recipient is the other person (yourself in notes), and it's unread for them; in a group it's in
// the pinned message's epoch, so exactly those who can read that message get it.
async function insertPinRow(table, message, userId) {
  if (table === 'direct_messages') {
    const otherId = message.sender_id === userId ? message.recipient_id : message.sender_id;
    const row = await db.run(
      `INSERT INTO direct_messages (sender_id, recipient_id, content, parent_message_id, system, timestamp)
       VALUES (?, ?, '', ?, ?, strftime('%s','now'))`,
      [userId, otherId, message.id, PIN_ROW]
    );
    if (otherId !== userId) await db.run(
      `INSERT INTO dm_unread (user_id, from_user_id, count, first_unread_id) VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id, from_user_id) DO UPDATE SET count = count + 1`,
      [otherId, userId, row.lastID]
    );
    return row.lastID;
  }
  if (table === 'group_dm_messages') {
    return (await db.run(
      `INSERT INTO group_dm_messages (group_id, epoch, sender_id, content, parent_message_id, system, timestamp)
       VALUES (?, ?, ?, '', ?, ?, strftime('%s','now'))`,
      [message.group_id, message.epoch, userId, message.id, PIN_ROW]
    )).lastID;
  }
  return (await db.run(
    `INSERT INTO guild_messages (channel_id, sender_id, content, parent_message_id, system, timestamp)
     VALUES (?, ?, '', ?, ?, strftime('%s','now'))`,
    [message.channel_id, userId, message.id, PIN_ROW]
  )).lastID;
}

// Pins (`pinned` true) or unpins message `messageId` of `table`. `chat` is SQL on that table's
// columns selecting the chat's messages, with `chatParams`, for the limit. -> { changed,
// pinned_at, pinned_by, rowId (the new "pinned a message" row, for announcePin) }, or
// { error, status } when the chat already has MAX_PINS or the message is a "pinned" row.
async function setPinned(table, messageId, userId, pinned, chat, chatParams) {
  return db.transaction(async () => {
    const message = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [messageId]);
    const row = { pinned_at: message.pinned_at, pinned_by: message.pinned_by };
    if (Boolean(row.pinned_at) === pinned) return { changed: false, ...row };
    let rowId = null;
    if (pinned) {
      if (message.system === PIN_ROW) return { error: "That can't be pinned", status: 400 };
      const { n } = await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${chat} AND pinned_at IS NOT NULL`, chatParams);
      if (n >= MAX_PINS) return { error: `A chat can have at most ${MAX_PINS} pinned messages. Unpin one first.`, status: 400 };
      await db.run(`UPDATE ${table} SET pinned_at = strftime('%s','now'), pinned_by = ? WHERE id = ?`, [userId, messageId]);
      rowId = await insertPinRow(table, message, userId);
    } else {
      await db.run(`UPDATE ${table} SET pinned_at = NULL, pinned_by = NULL WHERE id = ?`, [messageId]);
    }
    return { changed: true, rowId, ...(await db.get(`SELECT pinned_at, pinned_by FROM ${table} WHERE id = ?`, [messageId])) };
  });
}

// Sends a new "pinned a message" row (setPinned's `rowId`) to its chat and pushes it to the people
// it concerns (systemPushes.js). Never fails the pin.
async function announcePin(table, rowId) {
  if (!rowId) return;
  const kind = KIND_OF[table];
  try {
    await require('./pollTimers').deliverRow(kind, rowId);
    await require('./systemPushes').notifyPinned(kind, rowId);
  } catch (err) {
    console.error('Announcing a pin failed:', err.message);
  }
}

module.exports = { MAX_PINS, PIN_ROW, setPinned, announcePin };
