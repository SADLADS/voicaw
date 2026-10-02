const db = require('./db');

// Each person's spellcheck dictionary (the words they've added with "Add to Dictionary"),
// following their account to every device. Encrypted on the device (client
// spellcheck/personalDictionary.js): the server keeps one opaque `v1.` envelope per account
// and never sees the words. Padded on the device, so its length only says roughly how many.
// Saving names the version it was made from; a stale one gets 409 with the newer copy, so a
// device's word is never silently dropped by another's save.

// Room for a few thousand words (the client pads to 1 KiB steps and stops at 48 KiB).
const MAX_LENGTH = 70000;
const ENVELOPE = /^v1\.[A-Za-z0-9+/]+={0,2}$/;

function isValidEnvelope(value) {
  return typeof value === 'string' && value.length <= MAX_LENGTH && ENVELOPE.test(value);
}

// -> { dictionary: envelope or null, version } (version 0: never saved).
async function getDictionary(userId) {
  const row = await db.get('SELECT dictionary, dictionary_version FROM users WHERE id = ?', [userId]);
  return { dictionary: row?.dictionary ?? null, version: row?.dictionary_version ?? 0 };
}

// Saves `dictionary` over `version`. -> { saved: { dictionary, version } } or
// { conflict: the current one } or { error }.
async function saveDictionary(userId, dictionary, version) {
  if (!isValidEnvelope(dictionary)) return { error: 'Invalid dictionary' };
  if (!Number.isInteger(version) || version < 0) return { error: 'Invalid version' };
  return db.transaction(async () => {
    const current = await getDictionary(userId);
    if (current.version !== version) return { conflict: current };
    await db.run('UPDATE users SET dictionary = ?, dictionary_version = ? WHERE id = ?', [dictionary, version + 1, userId]);
    return { saved: { dictionary, version: version + 1 } };
  });
}

module.exports = { MAX_LENGTH, getDictionary, saveDictionary };
