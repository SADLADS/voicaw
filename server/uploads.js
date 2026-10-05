// Files in the `uploads` bucket (attachments, document images, webhooks' files) and what uses
// them, so a file goes once nothing does (docs/uploads.md, Deleting files).
//
// Every upload is a row in `uploads` from the moment its URL is handed out. A message or
// document that shows a file links to it (`upload_refs`): guild ones are read by the server
// (the URLs are in their text), encrypted chats' are listed by the client on send and edit
// (the server can't read those messages). cleanUpUploads drops the links of whatever no
// longer exists and deletes every file that was linked and isn't any more, or that was never
// linked within a day (a send that never happened). Files from before this (no `uploads` row)
// are never deleted.
const db = require('./db');
const { uploadKeysIn } = require('./uploadKeys');

const BUCKET = 'uploads';
// How long an upload may wait for the message that uses it.
const UNSENT_SECONDS = 24 * 60 * 60;
const SWEEP_MS = 10 * 60 * 1000;
// What a client may list for one message.
const MAX_LISTED = 100;
const MAX_KEY_LENGTH = 200;

// What links to files: a kind and the table its id is in. 'kept' (owner 0) is files sent by a
// client too old to list them: they stay for good, like files from before the registry.
const OWNERS = {
  dm: 'direct_messages',
  group: 'group_dm_messages',
  guild: 'guild_messages',
  doc: 'guild_documents',
  event: 'guild_events',
};

const now = () => Math.floor(Date.now() / 1000);

// The upload `key` (a name in the bucket) exists from now. `userId`: null for webhooks' files.
async function registerUpload(key, userId) {
  await db.run('INSERT OR IGNORE INTO uploads (key, user_id, created_at) VALUES (?, ?, ?)', [key, userId, now()]);
}

// What a guild message's row shows: its text, embeds and (webhooks') attachments.
function guildMessageKeys(row) {
  return uploadKeysIn([row.content, row.embeds, row.attachments].filter(Boolean).join('\n'));
}

// `kind` `ownerId` now shows exactly `keys` (only those of registered uploads count). Call
// inside the transaction that wrote it.
async function linkUploads(kind, ownerId, keys) {
  await db.run('DELETE FROM upload_refs WHERE kind = ? AND owner_id = ?', [kind, ownerId]);
  for (const key of keys) {
    const { changes } = await db.run(
      'INSERT OR IGNORE INTO upload_refs (kind, owner_id, key) SELECT ?, ?, key FROM uploads WHERE key = ?',
      [kind, ownerId, key]
    );
    if (changes) await db.run('UPDATE uploads SET linked = 1 WHERE key = ?', [key]);
  }
}

// The client's list for an encrypted message (`uploads` in the body): an array of names, or
// undefined if it sent none (an older client). Null if it isn't one.
function listedKeys(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LISTED) return null;
  if (!value.every((key) => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH)) return null;
  return new Set(value);
}

// Links an encrypted message to what its client listed. An older client lists nothing, so
// whatever its sender uploaded lately and hasn't sent yet must be in it: those are kept.
// `edit`: an edit from an older client changes nothing.
async function linkListed(kind, messageId, keys, userId, { edit = false } = {}) {
  if (keys) return linkUploads(kind, messageId, keys);
  if (edit) return;
  const recent = await db.all(
    `SELECT key FROM uploads u WHERE user_id = ? AND linked = 0 AND created_at > ?
       AND NOT EXISTS (SELECT 1 FROM upload_refs r WHERE r.key = u.key)`,
    [userId, now() - UNSENT_SECONDS]
  );
  for (const { key } of recent) {
    await db.run("INSERT OR IGNORE INTO upload_refs (kind, owner_id, key) VALUES ('kept', 0, ?)", [key]);
    await db.run('UPDATE uploads SET linked = 1 WHERE key = ?', [key]);
  }
}

// One pass: drops links whose owner is gone, then deletes the files nothing links to. The rows
// go first (in one transaction, checked again there); a file the object store fails to delete
// gets its row back, to be tried again next time.
async function sweep() {
  const keys = await db.transaction(async () => {
    for (const [kind, table] of Object.entries(OWNERS)) {
      await db.run(
        `DELETE FROM upload_refs WHERE kind = ? AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = upload_refs.owner_id)`,
        [kind]
      );
    }
    const unused = await db.all(
      `SELECT key, user_id, created_at FROM uploads u WHERE (linked = 1 OR created_at < ?)
         AND NOT EXISTS (SELECT 1 FROM upload_refs r WHERE r.key = u.key)`,
      [now() - UNSENT_SECONDS]
    );
    for (const { key } of unused) await db.run('DELETE FROM uploads WHERE key = ?', [key]);
    return unused;
  });
  const { deleteObject } = require('./s3');
  for (const row of keys) {
    if (await deleteObject(BUCKET, row.key)) continue;
    await db.run(
      'INSERT OR IGNORE INTO uploads (key, user_id, created_at, linked) VALUES (?, ?, ?, 1)',
      [row.key, row.user_id, row.created_at]
    );
  }
}

// Runs a sweep, or (if one is running) one more right after it. Resolves when done. Called
// after anything that may have stopped using a file (deletes, edits), and every few minutes.
let running = null;
let again = false;
function cleanUpUploads() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await sweep();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

// For routes: cleans up in the background (the request doesn't wait for the object store).
function releaseUploads() {
  cleanUpUploads().catch((err) => console.error('Upload cleanup failed:', err.message));
}

function startUploadCleanup() {
  releaseUploads();
  return setInterval(releaseUploads, SWEEP_MS);
}

module.exports = {
  BUCKET,
  UNSENT_SECONDS,
  registerUpload,
  guildMessageKeys,
  linkUploads,
  listedKeys,
  linkListed,
  cleanUpUploads,
  releaseUploads,
  startUploadCleanup,
};
