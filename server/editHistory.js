const db = require('./db');

// Message edit history (Edit history in docs/messages.md): before a message's content is
// replaced, the version it had is kept in `message_edits`, and everyone who can see the
// message can list them. `kind` is 'guild', 'dm' or 'group'; in DMs and groups the content is
// ciphertext (the server keeps what it already stored, and can read none of it). Deleting the
// message deletes them (db.js's triggers).

// Keeps `message`'s current version: a stored row with `content`, `timestamp`, `edited` and
// `edited_at`. Call it inside the edit's transaction, before the update. An edit that doesn't
// change the content keeps nothing.
async function keepVersion(kind, message, newContent) {
  if (message.content === newContent) return;
  await db.run(
    'INSERT INTO message_edits (kind, message_id, content, written_at, edited) VALUES (?, ?, ?, ?, ?)',
    [kind, message.id, message.content, message.edited ? message.edited_at ?? null : message.timestamp, message.edited ? 1 : 0]
  );
}

// -> [{ content, written_at, edited }], oldest first (the current version isn't among them).
function versions(kind, messageId) {
  return db.all(
    'SELECT content, written_at, edited FROM message_edits WHERE kind = ? AND message_id = ? ORDER BY id',
    [kind, messageId]
  );
}

module.exports = { keepVersion, versions };
