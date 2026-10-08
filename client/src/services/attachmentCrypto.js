// Attachments are encrypted client-side with a fresh AES-GCM key per file before upload,
// so the (public) uploads bucket only ever holds ciphertext. The key and the file's real
// type/size travel in the URL fragment, which browsers never send to the server, and the
// URL itself only ever appears inside an end-to-end encrypted message.
//
// Stored object layout: 12-byte IV || AES-GCM ciphertext (incl. 16-byte tag).
// URL: <fileUrl>#v=1&k=<base64url raw key>&t=<mime type>&s=<plaintext size in bytes>
//      [&w=<width>&h=<height>]  (images/videos, so their space is reserved before loading)
//      [&sp=1]  (marked as a spoiler: shown blurred until clicked)
//      [&p=<the thumbnail's object name, next to the file>]  (a big still image: a smaller
//      copy shown in the chat, so the file itself only downloads when it's opened, saved or
//      copied. It's IV || AES-GCM(JPEG/WebP/PNG) under the same key, with additional data
//      "voicaw/attachment-thumbnail/v1", so neither can pass for the other. Older clients
//      ignore it and show the file.)
// v=2 (chunkedAttachment.js: encrypted in pieces, so they can be streamed, seeked and saved a
// piece at a time) adds &n=<base nonce>, optionally &d=<duration in seconds> (videos) and
// &p=<the poster's or thumbnail's object name, next to the file> (sealed as a v2 poster).
// Videos have been v2 since 2026-10-01, every file since 2026-10-08 (big files had to be);
// v1 is only read now.
// A voice message (2026-10-09, services/voiceMessage.js) is a v2 audio file with &vm=1, its
// length (&d=) and &wf=<base64url waveform: one byte (0-255) per slice of the recording>.
// Older clients show it as a file to download.

import { toBase64Url, fromBase64Url } from './chunkedAttachment';
import { decodeWaveform, encodeWaveform } from './voiceMessage';

const IV_LENGTH = 12;

export const ENCRYPTION_OVERHEAD_BYTES = IV_LENGTH + 16;

const THUMBNAIL_CONTEXT = new TextEncoder().encode('voicaw/attachment-thumbnail/v1');

async function seal(key, plain, additionalData) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, ...(additionalData ? { additionalData } : {}) },
    key,
    plain
  );
  return new Blob([iv, ciphertext], { type: 'application/octet-stream' });
}

// Encrypts `file` (and its thumbnail, a Blob, if any) with a fresh key, as v1: no longer sent
// (attachmentUpload.js sends v2), kept for the tests of reading old files.
// Resolves to { blob, key, thumbnail: Blob | null }.
export async function encryptAttachment(file, thumbnailBlob = null) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const blob = await seal(key, await file.arrayBuffer());
  const thumbnail = thumbnailBlob ? await seal(key, await thumbnailBlob.arrayBuffer(), THUMBNAIL_CONTEXT) : null;
  const rawKey = await crypto.subtle.exportKey('raw', key);
  return { blob, key: toBase64Url(rawKey), thumbnail };
}

async function unseal(encrypted, keyB64Url, additionalData) {
  const bytes = new Uint8Array(encrypted);
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(keyB64Url),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_LENGTH), ...(additionalData ? { additionalData } : {}) },
    key,
    bytes.slice(IV_LENGTH)
  );
}

export function decryptAttachment(encrypted, keyB64Url) {
  return unseal(encrypted, keyB64Url);
}

// A v1 image's thumbnail (`p=`).
export function decryptThumbnail(encrypted, keyB64Url) {
  return unseal(encrypted, keyB64Url, THUMBNAIL_CONTEXT);
}

export function buildAttachmentUrl(fileUrl, { key, type, size, width, height, spoiler, nonce, duration, poster, waveform }) {
  const params = new URLSearchParams({ v: nonce ? '2' : '1', k: key, t: type, s: String(size) });
  if (nonce) params.set('n', nonce);
  if (width > 0 && height > 0) {
    params.set('w', String(width));
    params.set('h', String(height));
  }
  if (nonce && duration > 0) params.set('d', String(Math.round(duration * 10) / 10));
  if (poster) params.set('p', poster); // a video's poster, an image's thumbnail
  if (spoiler) params.set('sp', '1');
  if (nonce && waveform) {
    params.set('vm', '1');
    params.set('wf', encodeWaveform(waveform));
  }
  return `${fileUrl}#${params}`;
}

function positiveInt(value) {
  return /^[1-9]\d*$/.test(value ?? '') ? Number(value) : null;
}

// Returns { version, fileUrl, key, type, size, width, height, spoiler } for an encrypted
// attachment URL, or null for any other URL (legacy unencrypted uploads, external images, …).
// v2 adds { nonce, duration, voice (a voice message), waveform (its Uint8Array, or null) }. `posterUrl` is a video's poster (v2) or an image's thumbnail
// (v1), or null.
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
    v2.nonce = nonce;
    v2.duration = Number.isFinite(duration) && duration > 0 ? duration : null;
    v2.voice = params.get('vm') === '1';
    v2.waveform = v2.voice ? decodeWaveform(params.get('wf')) : null;
  }
  const poster = params.get('p');
  // Only a plain name in the same folder: the URL can't point the poster anywhere else.
  const posterUrl = /^[A-Za-z0-9_-]+\.bin$/.test(poster ?? '') ? fileUrl.replace(/[^/]*$/, poster) : null;
  return {
    version: Number(version),
    fileUrl,
    key,
    type: params.get('t') || 'application/octet-stream',
    size: /^\d+$/.test(size ?? '') ? Number(size) : null,
    width: width && height ? width : null,
    height: width && height ? height : null,
    spoiler: params.get('sp') === '1',
    posterUrl,
    ...v2,
  };
}
