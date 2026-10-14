import { getPrivacyPrefs } from '../utils/privacy';

// The offline copy (Offline copy, docs/messages.md): what this device has shown of your DMs,
// group DMs and notes, kept so they can be read without a connection. Text only (no
// attachments, pictures or guild channels), read-only, and only used when the server can't be
// reached; online, the app reads everything from the server as always and this only follows.
// IndexedDB `voicaw-offline`:
// - **messages**: [chat, id] -> { e: edited_at, iv, data }, a message as its chat hook showed it
//   (decrypted, reactions too), as AES-GCM ciphertext under a non-extractable key made on the
//   device (as the search copy's, services/searchIndex.js), bound to its chat and id. `chat` is
//   the search copy's conversation key (`<you>/dm/<them>`, `<you>/notes`, `<you>/group/<id>`).
// - **chats**: chat -> { runs: [[from, to], ...] }, the id ranges the copy holds without gaps
//   (ascending). Offline, a chat shows its newest run, so a gap is never passed over silently.
// - **docs**: `<you>|<name>` -> { iv, data }: the app's own lists (your profile, the DM list,
//   groups...), as the server last sent them (utils/api.js OFFLINE_GETS), sealed the same way.
// - **keys**: the device key.
// Ids, edit times and who a chat is with are stored in the clear: what the server knows anyway.
// Edits and deletes the app sees are followed at once; older parts are checked against the
// server's per-range counts when a chat opens (`checkChat`) and dropped where they changed.
// Settings → Privacy's "Keep an offline copy" (`offlineCopy`, on by default) turned off deletes
// it; logging out deletes it.

const DB_NAME = 'voicaw-offline';
const MESSAGES = 'messages';
const CHATS = 'chats';
const DOCS = 'docs';
const KEYS = 'keys';
const VERSION = 1;
// Older parts of a chat are checked in ranges of this many messages.
const CHECK_ROWS = 200;
const MAX_CHECK_RANGES = 500;

// Fields only the live chat needs (ciphertext the hooks already opened).
const DROPPED = ['content', 'parent_content', 'link_previews', 'localAttachments', 'clientKey', 'status'];

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(MESSAGES);
      req.result.createObjectStore(CHATS);
      req.result.createObjectStore(DOCS);
      req.result.createObjectStore(KEYS);
    };
    req.onsuccess = () => {
      const db = req.result;
      // An empty database of that name (something opened it without making the stores):
      // made again properly.
      if (!db.objectStoreNames.contains(MESSAGES)) {
        db.close();
        const del = indexedDB.deleteDatabase(DB_NAME);
        del.onsuccess = del.onerror = () => { dbPromise = null; openDb().then(resolve, reject); };
        return;
      }
      // Another tab clearing the copy: let it, and open again next time.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

// Runs `fn(stores)` in one transaction over `names`; resolves with `fn`'s return value's
// `result` (a request) or the value itself, once the transaction completes.
async function withStores(names, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const out = fn(Object.fromEntries(names.map((n) => [n, tx.objectStore(n)])));
    tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let keyPromise = null;

function deviceKey() {
  keyPromise ??= (async () => {
    const saved = await withStores([KEYS], 'readonly', (s) => s[KEYS].get('copy'));
    if (saved) return saved;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await withStores([KEYS], 'readwrite', (s) => s[KEYS].put(key, 'copy'));
    return key;
  })().catch((err) => {
    keyPromise = null;
    throw err;
  });
  return keyPromise;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function seal(purpose, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`voicaw/offline-${purpose}/v${VERSION}`) },
    await deviceKey(),
    encoder.encode(JSON.stringify(value)),
  );
  return { iv, data };
}

async function open(purpose, sealed) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.iv, additionalData: encoder.encode(`voicaw/offline-${purpose}/v${VERSION}`) },
    await deviceKey(),
    sealed.data,
  );
  return JSON.parse(decoder.decode(plain));
}

const messagePurpose = (chat, id) => `message\n${chat}\n${id}`;
const enabled = () => getPrivacyPrefs().offlineCopy;
const chatRange = (chat, from = 0, to = Infinity) => IDBKeyRange.bound([chat, from], [chat, to]);
const isSaved = (m) => Number.isInteger(m?.id);

function stripped(message) {
  const out = { ...message };
  for (const key of DROPPED) delete out[key];
  return out;
}

// --- The app's lists ---------------------------------------------------------------------

// Remembers `data` as `name` for user `userId` (a GET response, utils/api.js).
export async function saveDoc(userId, name, data) {
  if (!enabled() || userId == null) return;
  const key = `${userId}|${name}`;
  const sealed = await seal(`doc\n${key}`, data);
  await withStores([DOCS], 'readwrite', (s) => s[DOCS].put(sealed, key));
}

// What was saved as `name` for `userId`, or undefined.
export async function loadDoc(userId, name) {
  if (userId == null) return undefined;
  const key = `${userId}|${name}`;
  const sealed = await withStores([DOCS], 'readonly', (s) => s[DOCS].get(key));
  return sealed ? open(`doc\n${key}`, sealed) : undefined;
}

// --- Conversations -----------------------------------------------------------------------

// Saves a chat as its hook shows it: `messages` (in order; pending ones are skipped) are every
// message from the oldest shown to now, and `complete` says they reach the start of the
// conversation. Anything the copy held from the oldest shown on that isn't there any more was
// deleted. `previous` (the Map the last call returned) skips messages unchanged since: pass it
// back each time. Resolves to the Map for next time.
export async function saveChat(chat, messages, { complete = false, previous = null } = {}) {
  if (!enabled()) return null;
  const rows = messages.filter(isSaved);
  if (!rows.length && !complete) return previous;
  const ids = rows.map((m) => m.id);
  const from = complete ? 0 : Math.min(...ids);
  const to = rows.length ? Math.max(...ids) : 0;
  const kept = new Set(ids);
  const changed = rows.filter((m) => previous?.get(m.id) !== m);
  const sealed = await Promise.all(changed.map(async (m) => [
    m.id,
    { e: Number(m.edited_at) || 0, ...await seal(messagePurpose(chat, m.id), stripped(m)) },
  ]));
  await withStores([MESSAGES, CHATS], 'readwrite', (s) => {
    s[MESSAGES].getAllKeys(chatRange(chat, from)).onsuccess = (event) => {
      for (const key of event.target.result) if (!kept.has(key[1])) s[MESSAGES].delete(key);
    };
    for (const [id, value] of sealed) s[MESSAGES].put(value, [chat, id]);
    s[CHATS].get(chat).onsuccess = (event) => {
      // Runs from `from` on are replaced; one reaching it (ids overlapping what's shown, so
      // nothing lies between) joins the new one. Ids are shared by every conversation, so
      // runs that don't overlap may have messages between them: they stay apart.
      let start = from;
      const runs = [];
      for (const [f, t] of event.target.result?.runs ?? []) {
        if (f >= from) continue;
        if (t >= from - 1) start = f;
        else runs.push([f, t]);
      }
      if (to >= from) runs.push([start, to]);
      s[CHATS].put({ runs }, chat);
    };
  });
  return new Map(rows.map((m) => [m.id, m]));
}

// The chat's newest saved messages before id `before` (null: the newest), at most `limit`,
// oldest first, from its newest run only. -> { messages, hasMore (older ones saved),
// complete (the run reaches the start of the conversation) }, or null if nothing is saved.
export async function loadChat(chat, { before = null, limit = 50 } = {}) {
  const meta = await withStores([CHATS], 'readonly', (s) => s[CHATS].get(chat));
  const run = meta?.runs?.at(-1);
  if (!run) return null;
  const [from, to] = run;
  const high = before == null ? to : Math.min(to, before - 1);
  if (high < from) return { messages: [], hasMore: false, complete: from === 0 };
  const records = await withStores([MESSAGES], 'readonly', (s) => {
    const found = [];
    s[MESSAGES].openCursor(chatRange(chat, from, high), 'prev').onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor || found.length > limit) return;
      found.push([cursor.key[1], cursor.value]);
      cursor.continue();
    };
    return found;
  });
  const hasMore = records.length > limit;
  const shown = records.slice(0, limit).reverse();
  const messages = (await Promise.all(shown.map(async ([id, sealed]) => {
    try {
      return await open(messagePurpose(chat, id), sealed);
    } catch {
      return null; // a record that doesn't open (damaged): left out
    }
  }))).filter(Boolean);
  return { messages, hasMore, complete: from === 0 && !hasMore };
}

// Checks the parts of the chat saved before id `below` (what the open chat already shows is
// up to date) against the server: `fetchRanges([[from, to]])` -> [{ rows, edited }] (the
// hooks' search sources'). Ranges where a message was deleted or edited since are dropped
// from the copy (shown again, they're saved again).
export async function checkChat(chat, below, fetchRanges) {
  if (!enabled()) return;
  const [meta, records] = await withStores([CHATS, MESSAGES], 'readonly', (s) => {
    const out = [null, []];
    s[CHATS].get(chat).onsuccess = (event) => { out[0] = event.target.result; };
    s[MESSAGES].openCursor(chatRange(chat, 0, below - 1)).onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      out[1].push({ id: cursor.key[1], e: cursor.value.e });
      cursor.continue();
    };
    return out;
  });
  if (!meta?.runs?.length || !records.length) return;
  // Ranges of up to CHECK_ROWS saved messages, never across a run's end.
  const ranges = [];
  for (const [f, t] of meta.runs) {
    const inRun = records.filter((r) => r.id >= f && r.id <= t && r.id < below);
    for (let i = 0; i < inRun.length; i += CHECK_ROWS) {
      const part = inRun.slice(i, i + CHECK_ROWS);
      ranges.push({
        f: i === 0 ? f : part[0].id,
        t: i + CHECK_ROWS >= inRun.length ? Math.min(t, below - 1) : part.at(-1).id,
        rows: part.length,
        e: Math.max(...part.map((r) => r.e)),
      });
    }
  }
  const stale = [];
  for (let i = 0; i < ranges.length; i += MAX_CHECK_RANGES) {
    const part = ranges.slice(i, i + MAX_CHECK_RANGES);
    const counts = await fetchRanges(part.map((r) => [r.f, r.t]));
    part.forEach((r, j) => {
      if (counts[j]?.rows !== r.rows || (counts[j]?.edited ?? 0) > r.e) stale.push(r);
    });
  }
  if (!stale.length) return;
  await withStores([MESSAGES, CHATS], 'readwrite', (s) => {
    for (const r of stale) s[MESSAGES].delete(chatRange(chat, r.f, r.t));
    s[CHATS].get(chat).onsuccess = (event) => {
      // A dropped range splits its run: what's left on either side are runs of their own.
      let runs = event.target.result?.runs ?? [];
      for (const r of stale) {
        runs = runs.flatMap(([f, t]) => {
          if (r.t < f || r.f > t) return [[f, t]];
          return [...(f < r.f ? [[f, r.f - 1]] : []), ...(r.t < t ? [[r.t + 1, t]] : [])];
        });
      }
      s[CHATS].put({ runs }, chat);
    };
  });
}

// --- Settings ----------------------------------------------------------------------------

// How much the copy takes: { bytes, messages, chats } (bytes: the stored ciphertext).
export async function offlineCopySize() {
  // Measuring mustn't make the database again (opening one creates it).
  if (indexedDB.databases && !(await indexedDB.databases()).some((d) => d.name === DB_NAME)) return { bytes: 0, messages: 0, chats: 0 };
  return withStores([MESSAGES, DOCS, CHATS], 'readonly', (s) => {
    const out = { bytes: 0, messages: 0, chats: 0 };
    const sum = (store, count) => {
      store.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        out.bytes += cursor.value.data?.byteLength ?? 0;
        if (count) out.messages += 1;
        cursor.continue();
      };
    };
    sum(s[MESSAGES], true);
    sum(s[DOCS], false);
    s[CHATS].count().onsuccess = (event) => { out.chats = event.target.result; };
    return out;
  });
}

// Forgets everything (logging out, Settings → Privacy turning it off or Clear).
export async function clearOfflineCopy() {
  keyPromise = null;
  const db = await dbPromise?.catch(() => null);
  db?.close();
  dbPromise = null;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
