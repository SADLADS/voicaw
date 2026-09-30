const db = require('./db');

// Pinned messages, the same in DMs, group DMs and guild channels: a message's `pinned_at`
// (unix s) and `pinned_by`, null when it isn't pinned. Deleting a message takes its pin with it.
// Who may pin is up to each route (anyone in a DM or group, Pin Messages in a channel).

// Per chat, as in Discord.
const MAX_PINS = 250;

// Pins (`pinned` true) or unpins message `messageId` of `table`. `chat` is SQL on that table's
// columns selecting the chat's messages, with `chatParams`, for the limit. -> { changed,
// pinned_at, pinned_by }, or { error, status } when the chat already has MAX_PINS.
async function setPinned(table, messageId, userId, pinned, chat, chatParams) {
  return db.transaction(async () => {
    const row = await db.get(`SELECT pinned_at, pinned_by FROM ${table} WHERE id = ?`, [messageId]);
    if (Boolean(row.pinned_at) === pinned) return { changed: false, ...row };
    if (pinned) {
      const { n } = await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${chat} AND pinned_at IS NOT NULL`, chatParams);
      if (n >= MAX_PINS) return { error: `A chat can have at most ${MAX_PINS} pinned messages. Unpin one first.`, status: 400 };
      await db.run(`UPDATE ${table} SET pinned_at = strftime('%s','now'), pinned_by = ? WHERE id = ?`, [userId, messageId]);
    } else {
      await db.run(`UPDATE ${table} SET pinned_at = NULL, pinned_by = NULL WHERE id = ?`, [messageId]);
    }
    return { changed: true, ...(await db.get(`SELECT pinned_at, pinned_by FROM ${table} WHERE id = ?`, [messageId])) };
  });
}

module.exports = { MAX_PINS, setPinned };
