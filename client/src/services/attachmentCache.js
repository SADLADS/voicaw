import { decryptAttachment, decryptThumbnail } from './attachmentCrypto';
import { decryptChunkedAttachment, decryptPoster, encryptedSize } from './chunkedAttachment';

// Decrypted attachments, keyed by their full attachment URL, as Promise<objectURL>.
// Rows remount when a chat is reopened or a message is edited/re-sent, so without this
// they would download and decrypt the same files again.
const cache = new Map();
// The same entries once decrypted, readable synchronously so a remounted attachment can
// render straight away instead of flashing its loading state.
const resolved = new Map();
// The size of each entry's file (decrypted files are held by the browser, in memory or on
// disk), so a few big ones don't stay for the whole session. The newest is always kept.
const sizes = new Map();
let cachedBytes = 0;
const MAX_CACHED = 200;
const MAX_CACHED_BYTES = 256 * 1024 * 1024;

function forget(url) {
  const promise = cache.get(url);
  cache.delete(url);
  resolved.delete(url);
  cachedBytes -= sizes.get(url) ?? 0;
  sizes.delete(url);
  return promise;
}

// `bytes`: how big the file is (0 for one the browser already holds, e.g. the sender's own).
function remember(url, promise, bytes = 0) {
  if (cache.has(url)) forget(url);
  cache.set(url, promise);
  sizes.set(url, bytes);
  cachedBytes += bytes;
  promise.then((objectUrl) => {
    if (cache.get(url) === promise) resolved.set(url, objectUrl);
  }, () => {});
  while (cache.size > 1 && (cache.size > MAX_CACHED || cachedBytes > MAX_CACHED_BYTES)) {
    forget(cache.keys().next().value).then(URL.revokeObjectURL, () => {});
  }
  return promise;
}

export function getCachedAttachment(url) {
  return resolved.get(url) ?? null;
}

// Lets the sender reuse the local copy of a file they just uploaded instead of
// downloading and decrypting it again. Takes ownership of `objectUrl`.
export function seedAttachmentCache(url, objectUrl) {
  resolved.set(url, objectUrl);
  remember(url, Promise.resolve(objectUrl));
}

// Downloads a whole object, telling `onProgress(fraction)` as it arrives.
async function download(url, onProgress, expectedSize) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('Content-Length')) || expectedSize;
  if (!onProgress || !res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > out.length) throw new Error('Download larger than expected');
    out.set(value, received);
    received += value.length;
    onProgress(received / total);
  }
  return out.buffer.slice(0, received);
}

// Resolves to an object URL of the decrypted file. `onProgress(fraction)` hears about the
// download if this call starts it (a big video, downloaded to save or play in full).
export function loadDecryptedAttachment(url, meta, onProgress) {
  if (cache.has(url)) return cache.get(url);

  const promise = download(meta.fileUrl, onProgress, meta.version === 2 ? encryptedSize(meta.size) : null)
    .then((encrypted) => (meta.version === 2
      ? decryptChunkedAttachment(encrypted, meta.key, meta.nonce, meta.size)
      : decryptAttachment(encrypted, meta.key)))
    .then((plain) => URL.createObjectURL(new Blob([plain], { type: meta.type })));

  // Don't cache failures, so a later render can retry.
  promise.catch(() => cache.get(url) === promise && forget(url));
  return remember(url, promise, meta.size ?? 0);
}

// The type of a poster or thumbnail, from its first bytes (a JPEG, or a thumbnail with
// transparency: a WebP or PNG).
export function stillType(bytes) {
  const b = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
    return 'image/webp';
  }
  return 'image/jpeg';
}

// A v2 video's poster or a v1 image's thumbnail (a small still, `p=`), as an object URL.
export function loadDecryptedPoster(meta) {
  const key = `poster:${meta.posterUrl}`;
  if (cache.has(key)) return cache.get(key);
  const promise = download(meta.posterUrl)
    .then((encrypted) => (meta.version === 2 ? decryptPoster(encrypted, meta.key) : decryptThumbnail(encrypted, meta.key)))
    .then((plain) => URL.createObjectURL(new Blob([plain], { type: stillType(plain) })));
  promise.catch(() => cache.get(key) === promise && forget(key));
  return remember(key, promise);
}

export function getCachedPoster(meta) {
  return resolved.get(`poster:${meta.posterUrl}`) ?? null;
}
