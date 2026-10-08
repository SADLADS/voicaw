// The page's half of streaming encrypted videos (see mediaStreamWorker.js): hands out
// /__voicaw-media/<id> URLs for a <video>, and tells the service worker an id's file, key and
// size when it asks. Needs a service worker controlling the page that knows how (not the
// desktop app, which has none, nor a first visit before the worker has taken over, nor an
// older worker); without one, videos download in full when played.
import { MEDIA_PATH, MEDIA_META, MEDIA_PING, MEDIA_FAILED, MEDIA_SAVING } from './mediaStreamWorker';

const streams = new Map(); // id -> { fileUrl, key, nonce, size, type, download? }
const asked = new Set(); // ids the worker has asked about (so it's serving them)
const failed = new Set(); // ids the worker couldn't stream
const saving = new Set(); // download ids the worker has begun sending
let listening = false;
let checked = null; // { controller, result: Promise<{ stream, download }> }

function listen() {
  if (listening) return;
  listening = true;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === MEDIA_FAILED) failed.add(event.data.id);
    if (event.data?.type === MEDIA_SAVING) saving.add(event.data.id);
    if (event.data?.type !== MEDIA_META) return;
    asked.add(event.data.id);
    event.ports[0]?.postMessage(streams.get(event.data.id) ?? null);
  });
  navigator.serviceWorker.startMessages?.();
}

// What the worker can do: { stream, download }, all false without an answer. Workers from
// before downloads answer `true`.
function ping(controller) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({ stream: false, download: false }), 1500);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data === true ? { stream: true, download: false } : { stream: !!e.data?.stream, download: !!e.data?.download });
    };
    controller.postMessage({ type: MEDIA_PING }, [channel.port2]);
  });
}

function workerAbilities() {
  const controller = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
  if (!controller) return Promise.resolve({ stream: false, download: false });
  if (checked?.controller !== controller) {
    listen();
    checked = { controller, result: ping(controller) };
  }
  return checked.result;
}

// Whether videos can be streamed in this page.
export async function canStream() {
  return (await workerAbilities()).stream;
}

// Whether the worker can save files as they download (attachmentSave.js).
export async function canDownloadThroughWorker() {
  return (await workerAbilities()).download;
}

// A URL a <video> can play `meta` (a parsed v2 attachment URL) from; with `download` (a file
// name), one that saves the whole file as that, for a hidden frame to open.
export function streamUrl(meta, download = null) {
  const id = crypto.randomUUID();
  streams.set(id, {
    fileUrl: meta.fileUrl, key: meta.key, nonce: meta.nonce, size: meta.size, type: meta.type, ...(download ? { download } : {}),
  });
  return `${MEDIA_PATH}${id}`;
}

// Whether the worker has asked about `url`'s id (so it's serving it), whether that failed, and
// (a download) whether it has begun sending the file.
export function streamStatus(url) {
  const id = url.slice(MEDIA_PATH.length);
  return { asked: asked.has(id), failed: failed.has(id), saving: saving.has(id) };
}

export function isStreamUrl(url) {
  return typeof url === 'string' && url.startsWith(MEDIA_PATH);
}

// After a <video> playing `url` failed: whether streaming was the problem (the worker failed,
// or never served it), rather than a video the browser can't play. Waits a moment, since the
// worker's report can arrive after the player's error.
export async function streamFailed(url) {
  const id = url.slice(MEDIA_PATH.length);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return failed.has(id) || !asked.has(id);
}

export function releaseStream(url) {
  if (!isStreamUrl(url)) return;
  const id = url.slice(MEDIA_PATH.length);
  streams.delete(id);
  asked.delete(id);
  failed.delete(id);
  saving.delete(id);
}
