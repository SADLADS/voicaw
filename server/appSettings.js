// App-wide settings that a global admin edits in Settings → Admin (routes/admin.js). Each one
// can also come from server/.env (`env`); a value saved by an admin wins, and clearing it goes
// back to the .env value. Secret values never leave the server: the admin panel only learns
// whether one is set, and its last few characters.
const db = require('./db');

const SETTINGS = {
  klipyApiKey: {
    env: 'KLIPY_API_KEY',
    secret: true,
    label: 'Klipy API key',
    description: 'GIF search in the emoji picker (partner.klipy.com). Empty: no GIFs tab.',
  },
};

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
  if (values.has(key)) return values.get(key);
  return (def.env && process.env[def.env]) || '';
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
    const source = values.has(key) ? 'admin' : value ? 'env' : 'unset';
    out.push({
      key,
      label: def.label,
      description: def.description,
      secret: Boolean(def.secret),
      env: def.env ?? null,
      source,
      value: def.secret ? null : value,
      hint: def.secret && value ? `…${value.slice(-4)}` : null,
    });
  }
  return out;
}

module.exports = { SETTINGS, MAX_VALUE_LENGTH, getSetting, setSetting, describeSettings };
