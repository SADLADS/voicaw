const db = require('./db');

// Things a person keeps for themselves that follow their account to every device, encrypted on
// the device (the spellcheck dictionary, emoji usage): one opaque `v1.` envelope per account in
// a users column, beside a version. Saving names the version it was made from; a stale one gets
// the newer copy back, so one device's change is never silently dropped by another's save.

const ENVELOPE = /^v1\.[A-Za-z0-9+/]+={0,2}$/;

// `field`: the name the envelope goes by in the API ({ [field], version }); `column` and
// `versionColumn` in users; `maxLength`: the longest envelope taken.
function envelopeStore({ field, column, versionColumn, maxLength }) {
  const isValidEnvelope = (value) => typeof value === 'string' && value.length <= maxLength && ENVELOPE.test(value);

  // -> { [field]: envelope or null, version } (version 0: never saved).
  async function get(userId) {
    const row = await db.get(`SELECT ${column} AS envelope, ${versionColumn} AS version FROM users WHERE id = ?`, [userId]);
    return { [field]: row?.envelope ?? null, version: row?.version ?? 0 };
  }

  // Saves `envelope` over `version`. -> { saved: { [field], version } } or
  // { conflict: the current one } or { error }.
  async function save(userId, envelope, version) {
    if (!isValidEnvelope(envelope)) return { error: `Invalid ${field}` };
    if (!Number.isInteger(version) || version < 0) return { error: 'Invalid version' };
    return db.transaction(async () => {
      const current = await get(userId);
      if (current.version !== version) return { conflict: current };
      await db.run(`UPDATE users SET ${column} = ?, ${versionColumn} = ? WHERE id = ?`, [envelope, version + 1, userId]);
      return { saved: { [field]: envelope, version: version + 1 } };
    });
  }

  return { get, save };
}

module.exports = { envelopeStore };
