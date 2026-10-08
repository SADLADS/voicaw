// App-wide settings that a global admin edits in Settings → Admin (routes/admin.js). Each one
// can also come from server/.env (`env`); a value saved by an admin wins, and clearing it goes
// back to the .env value. Secret values never leave the server: the admin panel only learns
// whether one is set, and its last few characters. A setting with `choices` only takes one of
// them (the panel shows a menu), and `fallback` when it has none.
const db = require('./db');

const SETTINGS = {
  klipyApiKey: {
    env: 'KLIPY_API_KEY',
    secret: true,
    label: 'Klipy API key',
    description: 'GIF search in the emoji picker (partner.klipy.com). Empty: no GIFs tab.',
  },
  // signups.js
  signupMode: {
    env: 'SIGNUP_MODE',
    label: 'Sign-ups',
    description: 'Who can make an account: anyone, only people with an invite, or anyone, but they wait for an admin to approve them (an invite skips the wait).',
    choices: ['open', 'invite', 'request'],
    fallback: 'open',
  },
  // linkPreviews.js
  linkPreviews: {
    env: 'LINK_PREVIEWS',
    label: 'Link previews',
    description: 'Whether the server fetches links posted in guilds to show a preview of the page, picture or video under the message, as Discord does (the sites see this server asking). Never in DMs or group DMs.',
    choices: ['on', 'off'],
    fallback: 'on',
  },
  // voice.js joinToken: the most a screen share may send (client/src/voice/streamSettings.js).
  streamMaxResolution: {
    label: 'Screen share resolution limit',
    description: "The highest resolution anyone may share their screen at. Every stream goes through this server's LiveKit to each viewer, so higher means more of the server's bandwidth (1080p at 30 fps is about 4.5 Mbps per viewer). Applies from people's next join.",
    choices: ['source', '1080', '720'],
    fallback: 'source',
  },
  streamMaxFramerate: {
    label: 'Screen share frame rate limit',
    description: 'The highest frame rate anyone may share their screen at. Applies from their next join.',
    choices: ['60', '30', '15'],
    fallback: '60',
  },
  // routes/uploads.js, in MB (uploadLimitBytes).
  uploadLimit: {
    label: 'File size limit',
    description: "The biggest file anyone may attach, anywhere (DMs, group DMs, notes, guilds, documents, events). Files are kept until what shows them is deleted, so this is mostly about the object store's disk. Bots' files have their own limit (25 MB, as in Discord).",
    choices: ['500', '250', '100', '50', '25'],
    fallback: '500',
  },
};

const MB = 1024 * 1024;
const uploadLimitBytes = async () => Number(await getSetting('uploadLimit')) * MB;

const MAX_VALUE_LENGTH = 2000;

// key -> value saved by an admin (loaded once, then kept in step by set()).
let saved = null;

async function load() {
  if (!saved) {
    let rows;
    try {
      rows = await db.all('SELECT key, value FROM app_settings');
    } catch (err) {
      // A request in the first moments after start, before db.js has made the table.
      if (/no such table/.test(err.message)) return new Map();
      throw err;
    }
    saved = new Map(rows.map((r) => [r.key, r.value]));
  }
  return saved;
}

async function getSetting(key) {
  const def = SETTINGS[key];
  if (!def) throw new Error(`Unknown setting ${key}`);
  const values = await load();
  const value = values.has(key) ? values.get(key) : (def.env && process.env[def.env]) || '';
  if (def.choices && !def.choices.includes(value)) return def.fallback;
  return value;
}

// Whether `value` (not empty) can be saved for setting `key`.
function isValidValue(key, value) {
  const { choices } = SETTINGS[key];
  return !choices || choices.includes(value);
}

// `value` null (or '') removes the admin's value, so the .env one applies again.
async function setSetting(key, value, userId) {
  const values = await load();
  if (value == null || value === '') {
    await db.run('DELETE FROM app_settings WHERE key = ?', [key]);
    values.delete(key);
  } else {
    await db.run(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [key, value, userId, Math.floor(Date.now() / 1000)]
    );
    values.set(key, value);
  }
}

// What the admin panel shows: never a secret's value.
async function describeSettings() {
  const values = await load();
  const out = [];
  for (const [key, def] of Object.entries(SETTINGS)) {
    const value = await getSetting(key);
    const source = values.has(key) ? 'admin' : (def.env && process.env[def.env]) ? 'env' : 'unset';
    out.push({
      key,
      label: def.label,
      description: def.description,
      secret: Boolean(def.secret),
      choices: def.choices ?? null,
      env: def.env ?? null,
      source,
      value: def.secret ? null : value,
      hint: def.secret && value ? `…${value.slice(-4)}` : null,
    });
  }
  return out;
}

module.exports = { SETTINGS, MAX_VALUE_LENGTH, getSetting, setSetting, isValidValue, describeSettings, uploadLimitBytes };
