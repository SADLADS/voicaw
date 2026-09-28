import { decryptAttachment } from './attachmentCrypto';

// Decrypted attachments, keyed by their full attachment URL, as Promise<objectURL>.
// Virtuoso unmounts off-screen messages, so without this every scroll would re-download.
const cache = new Map();
const MAX_CACHED = 200;

function remember(url, promise) {
  cache.set(url, promise);
  while (cache.size > MAX_CACHED) {
    const [oldestUrl, oldest] = cache.entries().next().value;
    cache.delete(oldestUrl);
    oldest.then(URL.revokeObjectURL, () => {});
  }
  return promise;
}

// Lets the sender reuse the local copy of a file they just uploaded instead of
// downloading and decrypting it again. Takes ownership of `objectUrl`.
export function seedAttachmentCache(url, objectUrl) {
  remember(url, Promise.resolve(objectUrl));
}

export function loadDecryptedAttachment(url, meta) {
  if (cache.has(url)) return cache.get(url);

  const promise = fetch(meta.fileUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      return res.arrayBuffer();
    })
    .then((encrypted) => decryptAttachment(encrypted, meta.key))
    .then((plain) => URL.createObjectURL(new Blob([plain], { type: meta.type })));

  // Don't cache failures, so a later render can retry.
  promise.catch(() => cache.delete(url));
  return remember(url, promise);
}
