// Attachments that can be read in parts (v2: videos since 2026-10-01, every file since
// 2026-10-08): the file is encrypted in CHUNK_SIZE pieces, each its own AES-GCM message, so any
// byte range can be fetched, checked and decrypted without the rest. That lets a video start
// (or jump to the middle) without downloading what comes before, and a big file be sent and
// saved a piece at a time, never whole. See attachmentCrypto.js for the URL; this module has no
// DOM use, since the service worker (mediaStreamWorker.js) streams videos with it.
//
// Stored object layout: chunk 0 || chunk 1 || … each = AES-GCM(plaintext piece) incl. its
//   16-byte tag; every piece is CHUNK_SIZE bytes except the last (at least 1 byte, unless the
//   file is empty, when there's one empty chunk).
// Chunk i's IV: the 12-byte base nonce (`n` in the URL) with its last 4 bytes XORed with i.
// Additional data: "voicaw/attachment-chunk/v2" || i (u32 BE) || 1 if it's the last chunk
//   else 0, so chunks can't be reordered and the file can't be cut short.
// The poster (a still of the video, see mediaInfo.js) is IV || AES-GCM(JPEG) under the same
//   key, with additional data "voicaw/attachment-poster/v2", so it can't pass for a chunk.

export const CHUNK_SIZE = 256 * 1024;
export const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const encoder = new TextEncoder();
const CHUNK_CONTEXT = encoder.encode('voicaw/attachment-chunk/v2');
const POSTER_CONTEXT = encoder.encode('voicaw/attachment-poster/v2');

export function toBase64Url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function chunkCount(size) {
  return Math.max(1, Math.ceil(size / CHUNK_SIZE));
}

export function encryptedSize(size) {
  return size + chunkCount(size) * TAG_BYTES;
}

function chunkIv(nonce, index) {
  const iv = new Uint8Array(nonce);
  const view = new DataView(iv.buffer);
  view.setUint32(8, view.getUint32(8) ^ index);
  return iv;
}

function chunkContext(index, last) {
  const data = new Uint8Array(CHUNK_CONTEXT.length + 5);
  data.set(CHUNK_CONTEXT);
  new DataView(data.buffer).setUint32(CHUNK_CONTEXT.length, index);
  data[data.length - 1] = last ? 1 : 0;
  return data;
}

export function importChunkKey(keyB64Url) {
  return crypto.subtle.importKey('raw', fromBase64Url(keyB64Url), { name: 'AES-GCM' }, false, ['decrypt']);
}

// A fresh key and base nonce for encrypting `file` (a File or Blob) a part at a time, so a
// big file is never in memory whole: { size, count, encrypt(first, last), poster(blob), key,
// nonce } (`key` and `nonce` as they go in the URL). `encrypt` resolves to the stored bytes of
// chunks `first`..`last` (a Uint8Array); `poster` seals a still (a Blob) as the poster.
export async function chunkedEncryptor(file) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const { size } = file;
  const count = chunkCount(size);
  return {
    size,
    count,
    key: toBase64Url(await crypto.subtle.exportKey('raw', key)),
    nonce: toBase64Url(nonce),
    async encrypt(first, last) {
      const plain = new Uint8Array(await file.slice(first * CHUNK_SIZE, Math.min(size, (last + 1) * CHUNK_SIZE)).arrayBuffer());
      const out = new Uint8Array(plain.length + (last - first + 1) * TAG_BYTES);
      for (let i = first, at = 0; i <= last; i++) {
        const piece = plain.subarray((i - first) * CHUNK_SIZE, (i - first + 1) * CHUNK_SIZE);
        const sealed = new Uint8Array(await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: chunkIv(nonce, i), additionalData: chunkContext(i, i === count - 1) },
          key,
          piece,
        ));
        out.set(sealed, at);
        at += sealed.length;
      }
      return out;
    },
    async poster(blob) {
      const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: POSTER_CONTEXT },
        key,
        await blob.arrayBuffer(),
      );
      return new Blob([iv, sealed], { type: 'application/octet-stream' });
    },
  };
}

// Encrypts `file` (and its poster, a Blob, if any) with a fresh key, all at once (small files,
// sent in one request). Resolves to { blob, key, nonce, poster: Blob | null }.
export async function encryptChunkedAttachment(file, posterBlob = null) {
  const encryptor = await chunkedEncryptor(file);
  return {
    blob: new Blob([await encryptor.encrypt(0, encryptor.count - 1)], { type: 'application/octet-stream' }),
    key: encryptor.key,
    nonce: encryptor.nonce,
    poster: posterBlob ? await encryptor.poster(posterBlob) : null,
  };
}

export async function decryptPoster(encrypted, keyB64Url) {
  const bytes = new Uint8Array(encrypted);
  const key = await importChunkKey(keyB64Url);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, NONCE_BYTES), additionalData: POSTER_CONTEXT },
    key,
    bytes.slice(NONCE_BYTES),
  );
}

// Where in the stored object the plaintext bytes [start, end] (inclusive) are: the chunks
// `first`..`last`, stored at bytes [from, to] (inclusive).
export function encryptedRange(start, end, size) {
  const first = Math.floor(start / CHUNK_SIZE);
  const last = Math.min(Math.floor(end / CHUNK_SIZE), chunkCount(size) - 1);
  const stride = CHUNK_SIZE + TAG_BYTES;
  const lastLength = Math.min(CHUNK_SIZE, size - last * CHUNK_SIZE) + TAG_BYTES;
  return { first, last, from: first * stride, to: last * stride + lastLength - 1 };
}

// Decrypts the consecutive stored chunks `first`.. that `data` holds (as fetched for an
// encryptedRange). Resolves to their plaintext, joined. Throws if any was tampered with.
export async function decryptChunks(cryptoKey, nonceB64Url, size, first, data) {
  const nonce = fromBase64Url(nonceB64Url);
  const bytes = new Uint8Array(data);
  const count = chunkCount(size);
  const stride = CHUNK_SIZE + TAG_BYTES;
  const pieces = [];
  let total = 0;
  for (let offset = 0, i = first; offset < bytes.length; offset += stride, i++) {
    if (i >= count) throw new Error('Too much data for this attachment');
    const piece = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: chunkIv(nonce, i), additionalData: chunkContext(i, i === count - 1) },
      cryptoKey,
      bytes.subarray(offset, offset + stride),
    ));
    pieces.push(piece);
    total += piece.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

// Decrypts a whole stored file as it arrives: a TransformStream from its bytes (in pieces of
// any size, e.g. a fetch's body) to its plaintext, a chunk at a time, so saving a big file
// never holds it whole. Errors if a chunk was tampered with, or there's too much or too little.
export function decryptingStream(cryptoKey, nonceB64Url, size) {
  const nonce = fromBase64Url(nonceB64Url);
  const count = chunkCount(size);
  const stride = CHUNK_SIZE + TAG_BYTES;
  const lengthOf = (i) => (i < count - 1 ? stride : size - (count - 1) * CHUNK_SIZE + TAG_BYTES);
  const chunk = new Uint8Array(stride);
  let filled = 0;
  let index = 0;
  return new TransformStream({
    async transform(bytes, controller) {
      for (let at = 0; at < bytes.length;) {
        if (index >= count) throw new Error('Too much data for this attachment');
        const need = lengthOf(index) - filled;
        const take = Math.min(need, bytes.length - at);
        chunk.set(bytes.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === lengthOf(index)) {
          controller.enqueue(new Uint8Array(await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: chunkIv(nonce, index), additionalData: chunkContext(index, index === count - 1) },
            cryptoKey,
            chunk.subarray(0, filled),
          )));
          filled = 0;
          index++;
        }
      }
    },
    flush() {
      if (index < count) throw new Error('Attachment cut short');
    },
  });
}

// The whole file at once (downloads, and playing where there's no service worker).
export async function decryptChunkedAttachment(encrypted, keyB64Url, nonceB64Url, size) {
  if (encrypted.byteLength !== encryptedSize(size)) throw new Error('Attachment has the wrong size');
  const key = await importChunkKey(keyB64Url);
  return decryptChunks(key, nonceB64Url, size, 0, encrypted);
}
