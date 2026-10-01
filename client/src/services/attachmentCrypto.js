// Attachments are encrypted client-side with a fresh AES-GCM key per file before upload,
// so the (public) uploads bucket only ever holds ciphertext. The key and the file's real
// type/size travel in the URL fragment, which browsers never send to the server, and the
// URL itself only ever appears inside an end-to-end encrypted message.
//
// Stored object layout: 12-byte IV || AES-GCM ciphertext (incl. 16-byte tag).
// URL: <fileUrl>#v=1&k=<base64url raw key>&t=<mime type>&s=<plaintext size in bytes>
//      [&w=<width>&h=<height>]  (images/videos, so their space is reserved before loading)
//      [&sp=1]  (marked as a spoiler: shown blurred until clicked)

const IV_LENGTH = 12;
export const ENCRYPTION_OVERHEAD_BYTES = IV_LENGTH + 16;

function toBase64Url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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

export function buildAttachmentUrl(fileUrl, { key, type, size, width, height, spoiler }) {
  const params = new URLSearchParams({ v: '1', k: key, t: type, s: String(size) });
  if (width > 0 && height > 0) {
    params.set('w', String(width));
    params.set('h', String(height));
  }
  if (spoiler) params.set('sp', '1');
  return `${fileUrl}#${params}`;
}

function positiveInt(value) {
  return /^[1-9]\d*$/.test(value ?? '') ? Number(value) : null;
}

// Returns { fileUrl, key, type, size, width, height, spoiler } for an encrypted attachment URL, or null for any
// other URL (legacy unencrypted uploads, external images, …).
export function parseAttachmentUrl(url) {
  if (typeof url !== 'string') return null;
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return null;

  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const key = params.get('k');
  if (params.get('v') !== '1' || !key) return null;

  const size = params.get('s');
  const width = positiveInt(params.get('w'));
  const height = positiveInt(params.get('h'));
  return {
    fileUrl: url.slice(0, hashIndex),
    key,
    type: params.get('t') || 'application/octet-stream',
    size: /^\d+$/.test(size ?? '') ? Number(size) : null,
    width: width && height ? width : null,
    height: width && height ? height : null,
    spoiler: params.get('sp') === '1',
  };
}
