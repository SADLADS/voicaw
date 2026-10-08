// The service worker's half of streaming encrypted videos (the page's half is
// videoStream.js). A <video> plays /__voicaw-media/<id>; the browser asks for byte ranges as
// it plays and seeks, and each is answered by fetching only the encrypted chunks that cover
// it (chunkedAttachment.js), checking and decrypting them, and passing the bytes on as the
// player reads them. So nothing before a seek point is downloaded, and a player that stops
// reading (paused, enough buffered, seeked elsewhere) stops the download too.
//
// The key never goes into a URL: the worker asks the page that plays the video for it (by
// id), and keeps it in memory, which the browser clears whenever the worker stops.
//
// It also saves files (v2, any type) without the page holding them: the page opens
// /__voicaw-media/<id> in a hidden frame for an id whose meta has `download` (the file's name),
// and the worker answers with the whole file, downloaded and decrypted a chunk at a time, as an
// attachment, so the browser saves it as it arrives (attachmentSave.js).
import {
  CHUNK_SIZE, encryptedRange, decryptChunks, importChunkKey, decryptingStream, encryptedSize,
} from './chunkedAttachment';

export const MEDIA_PATH = '/__voicaw-media/';
export const MEDIA_META = 'voicaw-media-meta';
export const MEDIA_PING = 'voicaw-media-ping';
// To the page: streaming this id failed (a download or a chunk that didn't decrypt), so it
// can fall back to downloading the whole file, rather than blaming the video's format.
export const MEDIA_FAILED = 'voicaw-media-failed';
// To the page: a download (meta with `download`) has begun, so the browser is saving it.
export const MEDIA_SAVING = 'voicaw-media-saving';

// Chunks fetched per request: few at first (a quick start, also after a seek), then more.
const FIRST_BATCH = 2;
const MAX_BATCH = 8;
// Decrypted chunks kept per video (6 MiB), and videos kept.
const CACHED_CHUNKS = 24;
const CACHED_VIDEOS = 4;

const entries = new Map(); // id -> Promise<{ meta, key, chunks: Map<index, Uint8Array> }>

export function isMediaRequest(request) {
  const url = new URL(request.url);
  return request.method === 'GET' && url.origin === self.location.origin && url.pathname.startsWith(MEDIA_PATH);
}

function askClient(client, id) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 3000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    client.postMessage({ type: MEDIA_META, id }, [channel.port2]);
  });
}

async function loadEntry(id, clientId) {
  const own = clientId ? await self.clients.get(clientId) : null;
  const candidates = own ? [own] : await self.clients.matchAll({ type: 'window' });
  for (const client of candidates) {
    const meta = await askClient(client, id);
    if (meta) return { meta, key: await importChunkKey(meta.key), chunks: new Map() };
  }
  throw new Error('Unknown video');
}

function entryFor(id, clientId) {
  let entry = entries.get(id);
  if (entry) entries.delete(id);
  else {
    entry = loadEntry(id, clientId);
    entry.catch(() => entries.delete(id));
  }
  entries.set(id, entry);
  if (entries.size > CACHED_VIDEOS) entries.delete(entries.keys().next().value);
  return entry;
}

// [start, end] (inclusive) of a "bytes=…" Range header, null without one, or 'invalid'.
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid';
  let start;
  let end;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? 'invalid' : [start, end];
}

async function tellClients(clientId, message) {
  const client = clientId ? await self.clients.get(clientId) : null;
  const targets = client ? [client] : await self.clients.matchAll({ type: 'window' });
  targets.forEach((c) => c.postMessage(message));
}

const reportFailure = (clientId, id) => tellClients(clientId, { type: MEDIA_FAILED, id });

// Recently decrypted chunks, per video: players re-read (the start again after reading the
// index at the end, a little before a seek point), and those needn't be downloaded twice.
function remember(entry, index, plain) {
  entry.chunks.delete(index);
  entry.chunks.set(index, plain);
  if (entry.chunks.size > CACHED_CHUNKS) entry.chunks.delete(entry.chunks.keys().next().value);
}

// The plaintext bytes [start, end] of a video, fetched and decrypted only as the player reads
// them (no read-ahead of our own: the player's buffering decides. Tried 2026-10-08: 4 MB more
// ahead only added to what Chrome already buffers, 11.7 MB read for 2 s of a 15.6 MB video
// rather than about 6 MB).
function plaintextStream(entry, start, end, onFailure) {
  const { meta, key } = entry;
  const abort = new AbortController();
  let pos = start;
  let batch = FIRST_BATCH;
  return new ReadableStream({
    async pull(controller) {
      try {
        await next(controller);
      } catch (err) {
        if (!abort.signal.aborted) onFailure();
        throw err;
      }
    },
    cancel() {
      abort.abort();
    },
  }, { highWaterMark: 0 });

  // Hands on what's needed from `chunks` (plaintext of consecutive chunks from `first`).
  function deliver(controller, first, chunks) {
    const offset = pos - first * CHUNK_SIZE;
    const length = Math.min(chunks.length - offset, end - pos + 1);
    if (length <= 0) throw new Error('Video data cut short');
    controller.enqueue(chunks.subarray(offset, offset + length));
    pos += length;
    if (pos > end) controller.close();
  }

  async function next(controller) {
    const first = Math.floor(pos / CHUNK_SIZE);
    const cached = entry.chunks.get(first);
    if (cached) {
      remember(entry, first, cached);
      deliver(controller, first, cached);
      return;
    }
    // Up to `batch` chunks, stopping short of one already here.
    let last = Math.min(first + batch - 1, Math.floor(end / CHUNK_SIZE));
    for (let i = first + 1; i <= last; i++) {
      if (entry.chunks.has(i)) {
        last = i - 1;
        break;
      }
    }
    batch = Math.min(MAX_BATCH, batch * 2);
    const range = encryptedRange(first * CHUNK_SIZE, Math.min(meta.size - 1, (last + 1) * CHUNK_SIZE - 1), meta.size);
    const res = await fetch(meta.fileUrl, {
      headers: { Range: `bytes=${range.from}-${range.to}` },
      signal: abort.signal,
    });
    // A store that ignores Range would send the whole file for every piece: give up, and
    // the page falls back to downloading it once.
    if (res.status !== 206) throw new Error(`Range request failed (${res.status})`);
    const plain = await decryptChunks(key, meta.nonce, meta.size, range.first, await res.arrayBuffer());
    for (let i = range.first; i <= range.last; i++) {
      remember(entry, i, plain.subarray((i - range.first) * CHUNK_SIZE, (i - range.first + 1) * CHUNK_SIZE));
    }
    deliver(controller, range.first, plain);
  }
}

// `name` as a Content-Disposition attachment (RFC 6266: an ASCII fallback, then UTF-8).
export function attachmentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// The whole file, decrypted as it downloads, to be saved as `meta.download`.
async function respondWithDownload(event, id, entry) {
  const { meta, key } = entry;
  const res = await fetch(meta.fileUrl).catch(() => null);
  if (!res?.ok || !res.body || Number(res.headers.get('Content-Length') ?? encryptedSize(meta.size)) !== encryptedSize(meta.size)) {
    reportFailure(event.clientId, id);
    return new Response(null, { status: 502 });
  }
  tellClients(event.clientId, { type: MEDIA_SAVING, id });
  return new Response(res.body.pipeThrough(decryptingStream(key, meta.nonce, meta.size)), {
    headers: {
      'Content-Type': meta.type || 'application/octet-stream',
      'Content-Length': String(meta.size),
      'Content-Disposition': attachmentDisposition(meta.download),
      'Cache-Control': 'no-store',
    },
  });
}

async function respond(event) {
  const id = new URL(event.request.url).pathname.slice(MEDIA_PATH.length);
  let entry;
  try {
    entry = await entryFor(id, event.clientId);
  } catch {
    reportFailure(event.clientId, id);
    return new Response(null, { status: 404 });
  }
  if (entry.meta.download) return respondWithDownload(event, id, entry);
  const { size, type } = entry.meta;
  const range = parseRange(event.request.headers.get('Range'), size);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const [start, end] = range ?? [0, size - 1];
  const headers = {
    'Content-Type': type,
    'Content-Length': String(size ? end - start + 1 : 0),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = size ? plaintextStream(entry, start, end, () => reportFailure(event.clientId, id)) : null;
  return new Response(body, { status: range ? 206 : 200, headers });
}

export function handleMediaFetch(event) {
  event.respondWith(respond(event));
}
