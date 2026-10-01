// The page's half of streaming encrypted videos (see mediaStreamWorker.js): hands out
// /__voicaw-media/<id> URLs for a <video>, and tells the service worker an id's file, key and
// size when it asks. Needs a service worker controlling the page that knows how (not the
// desktop app, which has none, nor a first visit before the worker has taken over, nor an
// older worker); without one, videos download in full when played.
import { MEDIA_PATH, MEDIA_META, MEDIA_PING, MEDIA_FAILED } from './mediaStreamWorker';

const streams = new Map(); // id -> { fileUrl, key, nonce, size, type }
const asked = new Set(); // ids the worker has asked about (so it's serving them)
const failed = new Set(); // ids the worker couldn't stream
let listening = false;
let checked = null; // { controller, result: Promise<boolean> }

function listen() {
  if (listening) return;
  listening = true;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === MEDIA_FAILED) failed.add(event.data.id);
    if (event.data?.type !== MEDIA_META) return;
    asked.add(event.data.id);
    event.ports[0]?.postMessage(streams.get(event.data.id) ?? null);
  });
  navigator.serviceWorker.startMessages?.();
}

function ping(controller) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 1500);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    controller.postMessage({ type: MEDIA_PING }, [channel.port2]);
  });
}

// Whether videos can be streamed in this page.
export function canStream() {
  const controller = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
  if (!controller) return Promise.resolve(false);
  if (checked?.controller !== controller) {
    listen();
    checked = { controller, result: ping(controller) };
  }
  return checked.result;
}

// A URL a <video> can play `meta` (a parsed v2 attachment URL) from.
export function streamUrl(meta) {
  const id = crypto.randomUUID();
  streams.set(id, { fileUrl: meta.fileUrl, key: meta.key, nonce: meta.nonce, size: meta.size, type: meta.type });
  return `${MEDIA_PATH}${id}`;
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
}
