// Attachments are encrypted client-side with a fresh AES-GCM key per file before upload,
// so the (public) uploads bucket only ever holds ciphertext. The key and the file's real
// type/size travel in the URL fragment, which browsers never send to the server, and the
// URL itself only ever appears inside an end-to-end encrypted message.
//
// Stored object layout: 12-byte IV || AES-GCM ciphertext (incl. 16-byte tag).
// URL: <fileUrl>#v=1&k=<base64url raw key>&t=<mime type>&s=<plaintext size in bytes>
//      [&w=<width>&h=<height>]  (images/videos, so their space is reserved before loading)
//      [&sp=1]  (marked as a spoiler: shown blurred until clicked)
// Videos are v=2 (chunkedAttachment.js: encrypted in pieces, so they can be streamed and
// seeked), plus &n=<base nonce> and optionally &d=<duration in seconds> and
// &p=<the poster's object name, next to the file>.

import { toBase64Url, fromBase64Url } from './chunkedAttachment';

const IV_LENGTH = 12;

// Videos are encrypted in pieces (v2), so they can be streamed and seeked.
export function isStreamable(type) {
  return typeof type === 'string' && type.startsWith('video/');
}
export const ENCRYPTION_OVERHEAD_BYTES = IV_LENGTH + 16;

export async function encryptAttachment(file) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer());
  const rawKey = await crypto.subtle.exportKey('raw', key);

  return {
    blob: new Blob([iv, ciphertext], { type: 'application/octet-stream' }),
    key: toBase64Url(rawKey),
  };
}

export async function decryptAttachment(encrypted, keyB64Url) {
  const bytes = new Uint8Array(encrypted);
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(keyB64Url),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_LENGTH) },
    key,
    bytes.slice(IV_LENGTH)
  );
}

export function buildAttachmentUrl(fileUrl, { key, type, size, width, height, spoiler, nonce, duration, poster }) {
  const params = new URLSearchParams({ v: nonce ? '2' : '1', k: key, t: type, s: String(size) });
  if (nonce) params.set('n', nonce);
  if (width > 0 && height > 0) {
    params.set('w', String(width));
    params.set('h', String(height));
  }
  if (nonce && duration > 0) params.set('d', String(Math.round(duration * 10) / 10));
  if (nonce && poster) params.set('p', poster);
  if (spoiler) params.set('sp', '1');
  return `${fileUrl}#${params}`;
}

function positiveInt(value) {
  return /^[1-9]\d*$/.test(value ?? '') ? Number(value) : null;
}

// Returns { version, fileUrl, key, type, size, width, height, spoiler } for an encrypted
// attachment URL, or null for any other URL (legacy unencrypted uploads, external images, …).
// v2 adds { nonce, duration, posterUrl }.
export function parseAttachmentUrl(url) {
  if (typeof url !== 'string') return null;
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return null;

  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const key = params.get('k');
  const version = params.get('v');
  if ((version !== '1' && version !== '2') || !key) return null;

  const size = params.get('s');
  const width = positiveInt(params.get('w'));
  const height = positiveInt(params.get('h'));
  const fileUrl = url.slice(0, hashIndex);
  const v2 = {};
  if (version === '2') {
    const nonce = params.get('n');
    if (!/^[A-Za-z0-9_-]{16}$/.test(nonce ?? '') || !/^\d+$/.test(size ?? '')) return null;
    const duration = Number(params.get('d'));
    const poster = params.get('p');
    v2.nonce = nonce;
    v2.duration = Number.isFinite(duration) && duration > 0 ? duration : null;
    // Only a plain name in the same folder: the URL can't point the poster anywhere else.
    v2.posterUrl = /^[A-Za-z0-9_-]+\.bin$/.test(poster ?? '') ? fileUrl.replace(/[^/]*$/, poster) : null;
  }
  return {
    version: Number(version),
    fileUrl,
    key,
    type: params.get('t') || 'application/octet-stream',
    size: /^\d+$/.test(size ?? '') ? Number(size) : null,
    width: width && height ? width : null,
    height: width && height ? height : null,
    spoiler: params.get('sp') === '1',
    ...v2,
  };
}
