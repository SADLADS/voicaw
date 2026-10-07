const db = require('./db');

// Each person's own settings that follow their account to every device (Settings), unlike the
// per-device ones the client keeps in localStorage. Stored as JSON in users.preferences, only
// those changed from the default; nobody else sees them.
// - `blurNsfw`: media in NSFW channels is covered until clicked (on by default). Spoilers are
//   covered either way.
// - `adultConfirmed`: they ticked "I am 18 or over" (NSFW channels stay closed until then). Only
//   that answer is kept: never a date of birth or an age.

// - `botDms`: bots you share a guild with may message you (on by default; botDms.js). Off, they
//   can't start or continue a conversation; it stays readable.

// - `reactionNotifications`: notifications when someone reacts to your message, as Discord's:
//   'all' (the default), 'dms' (DMs and group DMs only) or 'off' (reactionPushes.js).

const REACTION_NOTIFICATIONS = ['all', 'dms', 'off'];
const DEFAULTS = { blurNsfw: true, adultConfirmed: false, botDms: true, reactionNotifications: 'all' };
const isValid = {
  blurNsfw: (v) => typeof v === 'boolean',
  adultConfirmed: (v) => typeof v === 'boolean',
  botDms: (v) => typeof v === 'boolean',
  reactionNotifications: (v) => REACTION_NOTIFICATIONS.includes(v),
};

function parse(json) {
  try {
    const saved = JSON.parse(json ?? '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

// `userId`'s preferences, every one of them (defaults for those never changed).
async function getPreferences(userId) {
  const row = await db.get('SELECT preferences FROM users WHERE id = ?', [userId]);
  const saved = parse(row?.preferences);
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, key in saved ? saved[key] : value]));
}

// Changes those of `changes` given; -> the new preferences, or a string saying what's wrong.
async function changePreferences(userId, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return 'Invalid preferences';
  for (const [key, value] of Object.entries(changes)) {
    if (!isValid[key]) return `Unknown preference ${key}`;
    if (!isValid[key](value)) return `Invalid ${key}`;
  }
  return db.transaction(async () => {
    const row = await db.get('SELECT preferences FROM users WHERE id = ?', [userId]);
    const saved = { ...parse(row?.preferences), ...changes };
    for (const key of Object.keys(saved)) if (!(key in DEFAULTS) || saved[key] === DEFAULTS[key]) delete saved[key];
    await db.run('UPDATE users SET preferences = ? WHERE id = ?', [Object.keys(saved).length ? JSON.stringify(saved) : null, userId]);
    return { ...DEFAULTS, ...saved };
  });
}

module.exports = { DEFAULTS, getPreferences, changePreferences };
