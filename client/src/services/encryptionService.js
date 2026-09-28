// End-to-end encryption primitives (WebCrypto only). Everything stored or sent is versioned
// so the scheme can evolve: message envelopes start with "v1.", key backups carry {v: 1},
// and every derived key / signature is bound to a "voicaw/<purpose>/v1" context string.
//
// Each user has two P-256 key pairs:
//   - identity (ECDSA): who the user is. Safety numbers are computed from it, and it signs
//     the user's other keys, so future per-device keys can be added without changing it.
//   - encryption (ECDH): used to derive per-conversation keys for DMs; signed by identity.
// Both private keys are stored on the server only inside a backup encrypted with a key
// derived from OPAQUE's exportKey (argon2id-stretched; the server can't compute it).

const te = new TextEncoder();
const td = new TextDecoder();

const ENCRYPTION_KEY_CONTEXT = 'voicaw/encryption-key/v1';
const KEY_BACKUP_CONTEXT = 'voicaw/key-backup/v1';
const DM_KEY_CONTEXT = 'voicaw/dm-key/v1';
const DM_MESSAGE_CONTEXT = 'voicaw/dm/v1';
export const MESSAGE_PREFIX = 'v1.';

// ---------------------------------------------------------------- encoding

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(b64) {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- user keys

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

function encryptionKeySignedData(encryptionKey) {
  return te.encode(`${ENCRYPTION_KEY_CONTEXT}\n${encryptionKey}`);
}

// New keys for a new account. `public` is published; `private` only ever leaves the device
// inside the encrypted key backup. Keys are base64: public keys as raw (uncompressed) points,
// private keys as PKCS#8.
export async function generateUserKeys() {
  const identity = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const encryption = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);

  const identityKey = toBase64(await crypto.subtle.exportKey('raw', identity.publicKey));
  const encryptionKey = toBase64(await crypto.subtle.exportKey('raw', encryption.publicKey));
  const encryptionKeySignature = toBase64(
    await crypto.subtle.sign(SIGN, identity.privateKey, encryptionKeySignedData(encryptionKey))
  );

  return {
    public: { identityKey, encryptionKey, encryptionKeySignature },
    private: {
      identityKey: toBase64(await crypto.subtle.exportKey('pkcs8', identity.privateKey)),
      encryptionKey: toBase64(await crypto.subtle.exportKey('pkcs8', encryption.privateKey)),
    },
  };
}

// True if `encryptionKey` really was signed by `identityKey`.
export async function verifyEncryptionKey({ identityKey, encryptionKey, encryptionKeySignature }) {
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(identityKey), ECDSA, false, ['verify']);
    return await crypto.subtle.verify(
      SIGN,
      key,
      fromBase64(encryptionKeySignature),
      encryptionKeySignedData(encryptionKey)
    );
  } catch {
    return false;
  }
}

// Non-extractable CryptoKeys for use on this device (see keyStore).
export function importIdentityPrivateKey(pkcs8Base64) {
  return crypto.subtle.importKey('pkcs8', fromBase64(pkcs8Base64), ECDSA, false, ['sign']);
}

export function importEncryptionPrivateKey(pkcs8Base64) {
  return crypto.subtle.importKey('pkcs8', fromBase64(pkcs8Base64), ECDH, false, ['deriveBits']);
}

// ---------------------------------------------------------------- key backup

async function keyBackupKey(exportKey) {
  const material = await crypto.subtle.importKey('raw', fromBase64(exportKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(KEY_BACKUP_CONTEXT) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypts the user's keys for storage on the server. The public keys are included so that
// after login the client can check the server is publishing the right ones.
export async function wrapKeyBackup(exportKey, userKeys) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = te.encode(JSON.stringify({ public: userKeys.public, private: userKeys.private }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(KEY_BACKUP_CONTEXT) },
    await keyBackupKey(exportKey),
    plaintext
  );
  return JSON.stringify({ v: 1, iv: toBase64(iv), ct: toBase64(ciphertext) });
}

// Throws if the backup can't be decrypted with this exportKey (wrong password / tampered).
export async function unwrapKeyBackup(exportKey, backup) {
  const { v, iv, ct } = JSON.parse(backup);
  if (v !== 1) throw new Error(`Unsupported key backup version ${v}`);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData: te.encode(KEY_BACKUP_CONTEXT) },
    await keyBackupKey(exportKey),
    fromBase64(ct)
  );
  return JSON.parse(td.decode(plaintext));
}

// ---------------------------------------------------------------- direct messages

// The key for a DM conversation: ECDH between my encryption key and theirs, run through HKDF.
export async function deriveConversationKey(myEncryptionPrivateKey, theirEncryptionKey) {
  const theirs = await crypto.subtle.importKey('raw', fromBase64(theirEncryptionKey), ECDH, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, myEncryptionPrivateKey, 256);
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(DM_KEY_CONTEXT) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Both people in a DM share one key, so the sender and recipient are bound into every
// message (AES-GCM additional data): the server can't make a message look like it came
// from the other person, or move it into a different conversation.
export function dmContext(senderId, recipientId) {
  return `${DM_MESSAGE_CONTEXT}|${senderId}|${recipientId}`;
}

// -> "v1.<base64(iv || ciphertext)>"
export async function encryptMessage(message, key, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(context) },
    key,
    te.encode(message)
  );
  return MESSAGE_PREFIX + toBase64(concat(iv, new Uint8Array(ciphertext)));
}

export async function decryptMessage(envelope, key, context) {
  if (typeof envelope !== 'string' || !envelope.startsWith(MESSAGE_PREFIX)) {
    throw new Error('Unsupported message format');
  }
  const bytes = fromBase64(envelope.slice(MESSAGE_PREFIX.length));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: te.encode(context) },
    key,
    bytes.slice(12)
  );
  return td.decode(plaintext);
}

// The other person in a DM, given one of the two participants.
function otherParticipant(msg, participantId) {
  return String(participantId) === String(msg.sender_id) ? msg.recipient_id : msg.sender_id;
}

// Decrypts a page of DM rows (and the messages they reply to), tolerating failures.
export async function decryptMessagesBatch(messages, key) {
  return Promise.all(messages.map(async (msg) => {
    let plaintext = null;
    let parentPlaintext = null;

    try {
      plaintext = await decryptMessage(msg.content, key, dmContext(msg.sender_id, msg.recipient_id));
    } catch (e) {
      console.warn('Failed to decrypt message', msg.id, e);
    }

    if (msg.parent_message_id && msg.parent_content) {
      try {
        // The parent is in the same conversation, so its recipient is the other participant.
        const parentRecipient = otherParticipant(msg, msg.parent_sender_id);
        parentPlaintext = await decryptMessage(
          msg.parent_content, key, dmContext(msg.parent_sender_id, parentRecipient)
        );
      } catch (e) {
        console.warn('Failed to decrypt parent message', msg.parent_message_id, e);
      }
    }

    return { ...msg, plaintext, parent_plaintext: parentPlaintext };
  }));
}
