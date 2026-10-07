const { db: sqlite, ...db } = require('./db');
const config = require('./config');
const { ActionError } = require('./actionError');

// Voice regions (docs/voice-and-calls.md, Voice regions): the LiveKit servers voice can go
// through, managed by global admins in Settings → Admin. The built-in one is server/.env's
// LiveKit (config.livekit; its url and keys are never stored or shown here); admins add others
// with a name, a flag and that server's url and API key and secret. One is the default:
// DM and group calls, and voice channels left on Automatic, use it. A voice channel can be put
// in another (guild channel settings, `rtc_region`).
//
// Each LiveKit server sends its webhooks to the same /api/livekit/webhook, signed with its own
// API key, which tells them apart (so two regions can't share a key). The secret never leaves
// the server: admins only see its last few characters.

const MAX_NAME = 50;
const MAX_FLAG = 16;
const MAX_FIELD = 500;

// Every region, in the order made (read straight from SQLite, so it's at hand without waiting:
// voice.js needs a region's LiveKit client in places that don't wait).
let cache = null;
function all() {
  cache ??= sqlite.prepare('SELECT * FROM voice_regions ORDER BY id').all();
  return cache;
}
const reload = () => { cache = null; };

const byId = (id) => all().find((r) => r.id === id) ?? null;

// How to reach the region's LiveKit: { url (browsers), apiUrl (this API), apiKey, apiSecret },
// or null when it can't be used (the built-in one without LIVEKIT_* in .env).
function connectionOf(region) {
  if (!region) return null;
  if (region.builtin) return config.livekit;
  if (!region.url || !region.api_key || !region.api_secret) return null;
  return {
    url: region.url,
    apiUrl: region.api_url || region.url.replace(/^ws/, 'http'),
    apiKey: region.api_key,
    apiSecret: region.api_secret,
  };
}

const defaultRegion = () => all().find((r) => r.is_default) ?? all().find((r) => r.builtin) ?? null;

// Where a voice channel's call goes: the channel's region (`rtc_region`) if it can be used,
// otherwise (Automatic, or a region that can't be reached) the default. Null when voice isn't
// set up at all.
function forChannel(channel) {
  const chosen = channel?.rtc_region != null ? byId(channel.rtc_region) : null;
  if (connectionOf(chosen)) return chosen;
  const fallback = defaultRegion();
  return connectionOf(fallback) ? fallback : null;
}

// Where DM and group calls go.
function forCalls() {
  const region = defaultRegion();
  return connectionOf(region) ? region : null;
}

// Whether voice can be used at all.
const available = () => forCalls() != null;

// The region whose LiveKit signs with `apiKey` (webhooks).
const byApiKey = (apiKey) => all().find((r) => connectionOf(r)?.apiKey === apiKey) ?? null;

// What the app shows (guild channel settings): no addresses or keys.
function listPublic() {
  return all().filter((r) => connectionOf(r)).map((r) => ({ id: r.id, name: r.name, flag: r.flag, default: Boolean(r.is_default) }));
}

// What the admin panel shows: the address, the key, and only the secret's last characters.
function listForAdmin() {
  return all().map((r) => {
    const connection = connectionOf(r);
    const secret = connection?.apiSecret;
    return {
      id: r.id,
      name: r.name,
      flag: r.flag,
      builtin: Boolean(r.builtin),
      default: Boolean(r.is_default),
      available: Boolean(connection),
      url: connection?.url ?? null,
      api_url: r.builtin ? (connection?.apiUrl ?? null) : r.api_url,
      api_key: connection?.apiKey ?? null,
      secret_hint: secret ? `…${secret.slice(-4)}` : null,
    };
  });
}

// ---- Admins' changes (routes/admin.js). Each throws ActionError on bad input. ----

const isUrl = (value, schemes) => {
  try {
    return schemes.includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

// The fields of `body` to save: { name, flag } for any region, and { url, apiUrl, apiKey,
// apiSecret } for one that isn't built in (a secret left out or empty keeps the old one).
function fieldsOf(body, region = null) {
  const out = {};
  if (body.name !== undefined || !region) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME) throw new ActionError(400, `Region names are 1–${MAX_NAME} characters`);
    out.name = name;
  }
  if (body.flag !== undefined) {
    if (body.flag !== null && typeof body.flag !== 'string') throw new ActionError(400, 'Invalid flag');
    const flag = (body.flag ?? '').trim();
    if (flag.length > MAX_FLAG) throw new ActionError(400, 'Invalid flag');
    out.flag = flag;
  }
  if (region?.builtin) {
    if (['url', 'apiUrl', 'apiKey', 'apiSecret'].some((key) => body[key] !== undefined)) {
      throw new ActionError(400, "The main region's server is set in server/.env");
    }
    return out;
  }
  const text = (key) => (typeof body[key] === 'string' ? body[key].trim() : body[key]);
  if (body.url !== undefined || !region) {
    const url = text('url');
    if (typeof url !== 'string' || url.length > MAX_FIELD || !isUrl(url, ['ws:', 'wss:'])) {
      throw new ActionError(400, 'The LiveKit address starts with wss:// (or ws://)');
    }
    out.url = url;
  }
  if (body.apiUrl !== undefined) {
    const apiUrl = text('apiUrl') || null;
    if (apiUrl != null && (typeof apiUrl !== 'string' || apiUrl.length > MAX_FIELD || !isUrl(apiUrl, ['http:', 'https:']))) {
      throw new ActionError(400, 'The API address starts with https:// (or http://)');
    }
    out.api_url = apiUrl;
  }
  if (body.apiKey !== undefined || !region) {
    const apiKey = text('apiKey');
    if (typeof apiKey !== 'string' || !apiKey || apiKey.length > MAX_FIELD) throw new ActionError(400, 'The API key is needed');
    if (all().some((r) => r.id !== region?.id && connectionOf(r)?.apiKey === apiKey)) {
      throw new ActionError(400, 'Another region already uses this API key (each LiveKit server needs its own)');
    }
    out.api_key = apiKey;
  }
  if ((body.apiSecret !== undefined && body.apiSecret !== '' && body.apiSecret !== null) || !region) {
    const apiSecret = text('apiSecret');
    if (typeof apiSecret !== 'string' || !apiSecret || apiSecret.length > MAX_FIELD) throw new ActionError(400, 'The API secret is needed');
    out.api_secret = apiSecret;
  }
  return out;
}

// Adds a region; resolves to its id.
async function createRegion(body) {
  const fields = { flag: '', ...fieldsOf(body ?? {}) };
  const { lastID } = await db.run(
    'INSERT INTO voice_regions (name, flag, url, api_url, api_key, api_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [fields.name, fields.flag, fields.url, fields.api_url ?? null, fields.api_key, fields.api_secret, Math.floor(Date.now() / 1000)]
  );
  reload();
  return lastID;
}

// Changes a region. `body.default: true` makes it the default. Resolves to what changed:
// { connection } (its server: people in it have to move) and { defaultChanged }.
async function updateRegion(id, body) {
  const region = byId(id);
  if (!region) throw new ActionError(404, 'Region not found');
  const { default: makeDefault, ...rest } = body ?? {};
  const fields = fieldsOf(rest, region);
  if (makeDefault !== undefined && makeDefault !== true) throw new ActionError(400, 'A region is made the default by choosing another one');
  if (makeDefault && !connectionOf({ ...region, ...fields })) throw new ActionError(400, "This region's server isn't set up");
  const before = connectionOf(region);
  await db.transaction(async () => {
    const keys = Object.keys(fields);
    if (keys.length) {
      await db.run(`UPDATE voice_regions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
    }
    if (makeDefault) {
      await db.run('UPDATE voice_regions SET is_default = 0 WHERE id != ?', [id]);
      await db.run('UPDATE voice_regions SET is_default = 1 WHERE id = ?', [id]);
    }
  });
  reload();
  const after = connectionOf(byId(id));
  return {
    connection: before?.url !== after?.url || before?.apiKey !== after?.apiKey || before?.apiSecret !== after?.apiSecret,
    defaultChanged: Boolean(makeDefault && !region.is_default),
  };
}

// Removes a region (not the built-in one). Its voice channels go back to Automatic; if it was
// the default, the built-in one is again. Resolves to the ids of the channels that were in it.
async function deleteRegion(id) {
  const region = byId(id);
  if (!region) throw new ActionError(404, 'Region not found');
  if (region.builtin) throw new ActionError(400, "The main region can't be removed");
  const channelIds = await db.transaction(async () => {
    const channels = await db.all('SELECT id FROM guild_channels WHERE rtc_region = ?', [id]);
    await db.run('UPDATE guild_channels SET rtc_region = NULL WHERE rtc_region = ?', [id]);
    await db.run('DELETE FROM voice_regions WHERE id = ?', [id]);
    if (region.is_default) await db.run('UPDATE voice_regions SET is_default = 1 WHERE builtin = 1');
    return channels.map((c) => c.id);
  });
  reload();
  return { channelIds, wasDefault: Boolean(region.is_default) };
}

module.exports = {
  all,
  byId,
  reload,
  connectionOf,
  defaultRegion,
  forChannel,
  forCalls,
  available,
  byApiKey,
  listPublic,
  listForAdmin,
  createRegion,
  updateRegion,
  deleteRegion,
};
