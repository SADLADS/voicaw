import { indexedWords, messageMatcher, searchHas } from '../utils/messageSearch';
import { getPrivacyPrefs } from '../utils/privacy';

// Searching DMs, group DMs and notes, which only the device can read (Search in encrypted
// chats, docs/messages.md). The device keeps its own copy of each conversation it has searched
// (IndexedDB `voicaw-search`), so a search reads history from the server only once:
// - **Segments**: each covers an id range of the conversation ([from, to], inclusive; together
//   they cover what's been read, newest to oldest, with no overlap) and holds the readable
//   messages in it ({ i: id, s: sender, t: time, p: text, n: its words, h: has: bits, u: 1 if
//   unsigned (an old group message) }), as AES-GCM ciphertext under a non-extractable key made
//   on the device and kept beside it, as the private keys are (keyStore.js). So the disk never
//   holds a message in the clear, and the copy is only as readable as the keys already are.
// - **Meta** (not encrypted: only what the server knows): each segment's range, how many
//   messages the server had in it (readable or not) and its latest edit time. Before searching,
//   the device asks the server for those numbers now (`fetchRanges`) and reads again any range
//   where something was deleted or edited, so deleted messages leave the copy and edits are
//   found. It never asks about particular messages, so the server can't tell what was found.
// - Searching decrypts a few segments at a time (`READ_BATCH`), so memory stays small however
//   long the history is.
// With Settings → Privacy's "Keep a search copy on this device" off (`searchCopy`), nothing is
// kept: every search reads the history from the server again, page by page, keeping only what
// matched. Logging out deletes the copy (clearSearchIndex).
//
// A `source` is one conversation, given by its chat hook (useConversation, useGroupConversation):
// { key (unique on the device: the account, the kind and the conversation), fetchPage(before,
//   limit) (server rows, oldest first; `before` null: the newest), toEntries(rows) (the readable
//   ones decrypted: [{ i, s, t, p, u? }]), fetchRanges([[from, to]]) ([{ rows, edited }]) }.

const DB_NAME = 'voicaw-search';
const META = 'meta';
const SEGMENTS = 'segments';
const KEYS = 'keys';
export const PAGE = 100;
const SEGMENT_ROWS = 200;
const READ_BATCH = 16;
const MAX_RANGES = 2000;
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META);
      req.result.createObjectStore(SEGMENTS);
      req.result.createObjectStore(KEYS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Runs `fn(stores)` in one transaction over `names`; resolves with what its last request got.
async function withStores(names, mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      const req = fn(Object.fromEntries(names.map((n) => [n, tx.objectStore(n)])));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

let keyPromise = null;

// The device's key for its search copy, made the first time.
function indexKey() {
  keyPromise ??= (async () => {
    const saved = await withStores([KEYS], 'readonly', (s) => s[KEYS].get('index'));
    if (saved) return saved;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await withStores([KEYS], 'readwrite', (s) => s[KEYS].put(key, 'index'));
    return key;
  })().catch((err) => {
    keyPromise = null;
    throw err;
  });
  return keyPromise;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// Binds a segment to its place, so one can't be passed off as another.
const segmentData = (conv, from) => encoder.encode(`voicaw/search-segment/v${VERSION}\n${conv}\n${from}`);

async function sealSegment(conv, from, entries) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: segmentData(conv, from) }, await indexKey(), encoder.encode(JSON.stringify(entries))
  );
  return { v: VERSION, iv, data };
}

async function openSegment(conv, from, sealed) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.iv, additionalData: segmentData(conv, from) }, await indexKey(), sealed.data
  );
  return JSON.parse(decoder.decode(plain));
}

const loadMeta = async (conv) => (await withStores([META], 'readonly', (s) => s[META].get(conv))) ?? { segs: [] };

const sortSegs = (segs) => segs.sort((a, b) => a.f - b.f);

// One conversation at a time (across tabs too, where the browser can), so two syncs don't
// write the same ranges.
const localLocks = new Map();
function withLock(conv, fn) {
  const name = `voicaw-search:${conv}`;
  if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request(name, fn);
  const previous = localLocks.get(name) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  localLocks.set(name, run);
  return run;
}

function checkAborted(signal) {
  if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
}

const toEntry = (e) => ({ ...e, n: indexedWords(e.p), h: searchHas(e.p) });

// Reads the conversation's messages with ids in (low, high) (high: Infinity for the newest),
// newest first, a page at a time, calling `onChunk({ from, to, rows, edited, entries })` for each
// run of about SEGMENT_ROWS, which together cover exactly (low, high) once it returns. Rows the
// server sent that can't be read (system rows, unreadable or forged ones) count in `rows` but
// have no entry. `onRead(n)` after every page.
async function readRange(source, low, high, onChunk, { signal, onRead } = {}) {
  let cursor = high;
  let to = high === Infinity ? null : high - 1;
  let rows = [];
  const flush = async (done) => {
    if (!rows.length && (!done || to == null || low + 1 > to)) return;
    const ids = rows.map((r) => r.id);
    const from = done ? low + 1 : Math.min(...ids);
    const chunkTo = to ?? Math.max(...ids);
    const edited = rows.reduce((max, r) => Math.max(max, Number(r.edited_at) || 0), 0);
    const entries = (await source.toEntries(rows)).map(toEntry);
    await onChunk({ from, to: chunkTo, rows: rows.length, edited, entries });
    to = from - 1;
    rows = [];
  };
  for (;;) {
    checkAborted(signal);
    const page = await source.fetchPage(cursor === Infinity ? null : cursor, PAGE);
    checkAborted(signal);
    const inRange = page.filter((r) => r.id > low);
    const done = page.length < PAGE || inRange.length < page.length;
    rows = [...inRange, ...rows];
    onRead?.(inRange.length);
    if (rows.length >= SEGMENT_ROWS || done) await flush(done);
    if (done) return;
    cursor = Math.min(...page.map((r) => r.id));
  }
}

// Brings the device's copy of `source` up to date: the newest messages, ranges that changed on
// the server (deleted or edited messages), gaps left by an interrupted read, then older history.
async function sync(source, { signal, onProgress }) {
  const conv = source.key;
  let read = 0;
  const onRead = (n) => {
    read += n;
    onProgress?.(read);
  };
  await withLock(conv, async () => {
    const meta = await loadMeta(conv);
    const save = async ({ from, to, rows, edited, entries }) => {
      const sealed = await sealSegment(conv, from, entries);
      const overlapped = meta.segs.filter((s) => s.to >= from && s.f <= to);
      meta.segs = sortSegs([...meta.segs.filter((s) => !overlapped.includes(s)), { f: from, to, rows, ed: edited }]);
      await withStores([META, SEGMENTS], 'readwrite', (s) => {
        for (const seg of overlapped) s[SEGMENTS].delete([conv, seg.f]);
        s[SEGMENTS].put(sealed, [conv, from]);
        return s[META].put(meta, conv);
      });
    };
    const drop = async (segs) => {
      meta.segs = meta.segs.filter((s) => !segs.includes(s));
      await withStores([META, SEGMENTS], 'readwrite', (s) => {
        for (const seg of segs) s[SEGMENTS].delete([conv, seg.f]);
        return s[META].put(meta, conv);
      });
    };

    // Newest first: what's most likely to be looked for.
    await readRange(source, meta.segs.at(-1)?.to ?? 0, Infinity, save, { signal, onRead });

    // Ranges that changed since they were read. (`top`: the newest id read, so a dropped newest
    // range is read again too.)
    const known = [...meta.segs];
    const top = known.at(-1)?.to ?? 0;
    const stale = [];
    for (let i = 0; i < known.length; i += MAX_RANGES) {
      const part = known.slice(i, i + MAX_RANGES);
      const counts = await source.fetchRanges(part.map((s) => [s.f, s.to]));
      part.forEach((seg, j) => {
        if (counts[j]?.rows !== seg.rows || (counts[j]?.edited ?? 0) !== seg.ed) stale.push(seg);
      });
    }
    if (stale.length) await drop(stale);

    // Gaps (stale ranges just dropped, or a read that was interrupted), newest first, then the
    // rest of the history.
    for (;;) {
      checkAborted(signal);
      const segs = meta.segs;
      let gap = (segs.at(-1)?.to ?? 0) < top ? [segs.at(-1)?.to ?? 0, top + 1] : null;
      for (let i = segs.length - 1; i > 0 && !gap; i -= 1) {
        if (segs[i - 1].to + 1 < segs[i].f) gap = [segs[i - 1].to, segs[i].f];
      }
      if (!gap && segs.length && segs[0].f > 1) gap = [0, segs[0].f];
      if (!gap) break;
      await readRange(source, gap[0], gap[1], save, { signal, onRead });
    }
  });
}

// Reads the segments of `conv` in order (newest first if `desc`), a few at a time, calling
// `visit(entries)` for each (entries newest first if `desc`).
async function scanStored(conv, segs, desc, visit, signal) {
  const ordered = desc ? [...segs].reverse() : segs;
  for (let i = 0; i < ordered.length; i += READ_BATCH) {
    checkAborted(signal);
    const batch = ordered.slice(i, i + READ_BATCH);
    // (One transaction for the batch: withStores resolves with `result`, filled in as they arrive.)
    const sealed = await withStores([SEGMENTS], 'readonly', (s) => {
      const result = [];
      batch.forEach((seg, j) => {
        const req = s[SEGMENTS].get([conv, seg.f]);
        req.onsuccess = () => { result[j] = req.result; };
      });
      return { result };
    });
    for (const [j, seg] of batch.entries()) {
      if (!sealed[j]) continue;
      const entries = await openSegment(conv, seg.f, sealed[j]);
      visit(desc ? entries.reverse() : entries);
    }
  }
}

// Collects matches: the total, and the first `limit` in the order they're visited (`keepLast`:
// the last `limit`, for the oldest first when visiting newest first).
function collector(match, limit, keepLast = false) {
  const found = [];
  let total = 0;
  return {
    visit(entries) {
      for (const entry of entries) {
        if (!match(entry)) continue;
        total += 1;
        if (keepLast) {
          found.push(entry);
          if (found.length > limit) found.shift();
        } else if (found.length < limit) {
          found.push(entry);
        }
      }
    },
    result: () => ({ total, messages: keepLast ? found.reverse() : found }),
  };
}

// A kept message as the chat draws one (MessageContent; no reactions).
const toMessage = ({ i, s, t, p, u }) => ({ id: i, sender_id: s, timestamp: t, plaintext: p, reactions: [], ...(u ? { unsigned: true } : {}) });

// Searches `source` for `params` (utils/searchQuery.js parseSearch: content, author_id,
// mentions, has). -> { total, messages: [{ id, sender_id, timestamp, plaintext, reactions,
// unsigned? }] }, the first `limit` in `sort` order ('desc': newest first). `sync` false skips bringing the copy up to date (Load more).
// `onProgress(n)`: messages read from the server so far.
export async function searchConversation(source, params, { sort = 'desc', limit = 25, sync: doSync = true, signal, onProgress } = {}) {
  const match = messageMatcher(params);
  const desc = sort !== 'asc';

  if (!getPrivacyPrefs().searchCopy) {
    // Nothing kept: read it all again, newest first, keeping only matches.
    const found = collector(match, limit, !desc);
    let read = 0;
    await readRange(source, 0, Infinity, ({ entries }) => found.visit([...entries].reverse()), {
      signal,
      onRead: (n) => { read += n; onProgress?.(read); },
    });
    const { total, messages } = found.result();
    return { total, messages: messages.map(toMessage) };
  }

  if (doSync) await sync(source, { signal, onProgress });
  const { segs } = await loadMeta(source.key);
  const found = collector(match, limit);
  await scanStored(source.key, segs, desc, found.visit, signal);
  const { total, messages } = found.result();
  return { total, messages: messages.map(toMessage) };
}

// How much the copy takes (Settings → Privacy → Storage): { bytes (the stored ciphertext),
// chats }.
export async function searchIndexSize() {
  // Measuring mustn't make the database again (opening one creates it).
  if (indexedDB.databases && !(await indexedDB.databases()).some((d) => d.name === DB_NAME)) return { bytes: 0, chats: 0 };
  return withStores([SEGMENTS, META], 'readonly', (s) => {
    const out = { bytes: 0, chats: 0 };
    s[SEGMENTS].openCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      out.bytes += cursor.value?.data?.byteLength ?? 0;
      cursor.continue();
    };
    s[META].count().onsuccess = (event) => { out.chats = event.target.result; };
    return { result: out };
  });
}

// Forgets every conversation's copy (logging out, or Settings → Privacy turning it off).
export async function clearSearchIndex() {
  keyPromise = null;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
