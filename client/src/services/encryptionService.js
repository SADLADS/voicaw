// End-to-end encryption primitives (WebCrypto only). Everything stored or sent is versioned
// so the scheme can evolve: message envelopes start with "v1.", key backups carry {v: 1},
// and every derived key / signature is bound to a "voicaw/<purpose>/v1" context string.
//
// Each user has two P-256 key pairs:
//   - identity (ECDSA): who the user is. Safety numbers are computed from it, and it signs
//     the user's other keys, so future per-device keys can be added without changing it.
//   - encryption (ECDH): used to derive per-conversation keys for DMs; signed by identity.
// Both private keys are stored on the server only inside a backup encrypted with a key
// derived from OPAQUE's exportKey (argon2id-stretched; the server can't compute it), and
// optionally in a second backup encrypted with a key derived from a recovery code.

const te = new TextEncoder();
const td = new TextDecoder();

const ENCRYPTION_KEY_CONTEXT = 'voicaw/encryption-key/v1';
const KEY_BACKUP_CONTEXT = 'voicaw/key-backup/v1';
const RECOVERY_BACKUP_CONTEXT = 'voicaw/recovery-backup/v1';
const RECOVERY_AUTH_CONTEXT = 'voicaw/recovery-auth/v1';
const DM_KEY_CONTEXT = 'voicaw/dm-key/v1';
const NOTES_KEY_CONTEXT = 'voicaw/notes-key/v1';
const DM_MESSAGE_CONTEXT = 'voicaw/dm/v1';
const DM_REACTION_CONTEXT = 'voicaw/dm-reaction/v1';
const CALL_KEY_CONTEXT = 'voicaw/call-key/v1';
const DICTIONARY_KEY_CONTEXT = 'voicaw/dictionary-key/v1';
const DICTIONARY_CONTEXT = 'voicaw/dictionary/v1';
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

// An AES-GCM key (or raw bits) from `secret` with HKDF, bound to `context`.
async function hkdf(secret, context, algorithm) {
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const params = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(context) };
  if (!algorithm) return new Uint8Array(await crypto.subtle.deriveBits(params, material, 256));
  return crypto.subtle.deriveKey(params, material, algorithm, false, ['encrypt', 'decrypt']);
}

const AES_GCM = { name: 'AES-GCM', length: 256 };

function keyBackupKey(exportKey) {
  return hkdf(fromBase64(exportKey), KEY_BACKUP_CONTEXT, AES_GCM);
}

async function wrapKeys(key, context, userKeys) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = te.encode(JSON.stringify({ public: userKeys.public, private: userKeys.private }));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(context) }, key, plaintext);
  return JSON.stringify({ v: 1, iv: toBase64(iv), ct: toBase64(ciphertext) });
}

async function unwrapKeys(key, context, backup) {
  const { v, iv, ct } = JSON.parse(backup);
  if (v !== 1) throw new Error(`Unsupported key backup version ${v}`);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData: te.encode(context) },
    key,
    fromBase64(ct)
  );
  return JSON.parse(td.decode(plaintext));
}

// Encrypts the user's keys for storage on the server. The public keys are included so that
// after login the client can check the server is publishing the right ones.
export async function wrapKeyBackup(exportKey, userKeys) {
  return wrapKeys(await keyBackupKey(exportKey), KEY_BACKUP_CONTEXT, userKeys);
}

// Throws if the backup can't be decrypted with this exportKey (wrong password / tampered).
export async function unwrapKeyBackup(exportKey, backup) {
  return unwrapKeys(await keyBackupKey(exportKey), KEY_BACKUP_CONTEXT, backup);
}

// ---------------------------------------------------------------- recovery code

// A recovery code is 25 random Crockford base32 characters (125 bits), shown in groups of
// five. It's random enough that no stretching is needed. Two things are derived from it: a
// key that encrypts a second copy of the key backup, and an "auth" value the client sends
// to the server to prove it has the code. The server only stores SHA-256 of the auth value
// (the verifier), so neither its database nor the auth value reveals the backup key.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_LENGTH = 25;

export function generateRecoveryCode() {
  // 256 is a multiple of 32, so masking keeps every character equally likely.
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(RECOVERY_LENGTH)), (b) => RECOVERY_ALPHABET[b & 31]);
  return chars.join('').match(/.{5}/g).join('-');
}

// The code in its canonical form (no dashes or spaces, upper case, O read as 0 and I/L as 1),
// or null if it can't be a recovery code.
export function normalizeRecoveryCode(input) {
  const code = String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (code.length !== RECOVERY_LENGTH || [...code].some((c) => !RECOVERY_ALPHABET.includes(c))) return null;
  return code;
}

function recoverySecret(code) {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) throw new Error("That isn't a valid recovery code.");
  return te.encode(normalized);
}

// What the client sends to prove it has the code (base64).
export async function recoveryAuth(code) {
  return toBase64(await hkdf(recoverySecret(code), RECOVERY_AUTH_CONTEXT));
}

// What the server stores to check recoveryAuth against (base64 SHA-256 of it).
export async function recoveryVerifier(auth) {
  return toBase64(await crypto.subtle.digest('SHA-256', fromBase64(auth)));
}

export async function wrapRecoveryBackup(code, userKeys) {
  const key = await hkdf(recoverySecret(code), RECOVERY_BACKUP_CONTEXT, AES_GCM);
  return wrapKeys(key, RECOVERY_BACKUP_CONTEXT, userKeys);
}

// Throws if the backup can't be decrypted with this code.
export async function unwrapRecoveryBackup(code, backup) {
  const key = await hkdf(recoverySecret(code), RECOVERY_BACKUP_CONTEXT, AES_GCM);
  return unwrapKeys(key, RECOVERY_BACKUP_CONTEXT, backup);
}

// ---------------------------------------------------------------- direct messages

// The key for a DM conversation: ECDH between my encryption key and theirs, run through HKDF.
export function deriveConversationKey(myEncryptionPrivateKey, theirEncryptionKey) {
  return deriveEcdhKey(myEncryptionPrivateKey, theirEncryptionKey, DM_KEY_CONTEXT);
}

// The key for your notes (a DM to yourself): ECDH between your own private and public
// encryption keys, so only your key pair can open them. Its own HKDF label keeps it apart
// from any DM key. `myEncryptionKey` must be your public key from this device (keyStore),
// never the server's copy.
export function deriveNotesKey(myEncryptionPrivateKey, myEncryptionKey) {
  return deriveEcdhKey(myEncryptionPrivateKey, myEncryptionKey, NOTES_KEY_CONTEXT);
}

async function deriveEcdhKey(myEncryptionPrivateKey, theirEncryptionKey, context) {
  const theirs = await crypto.subtle.importKey('raw', fromBase64(theirEncryptionKey), ECDH, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, myEncryptionPrivateKey, 256);
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(context) },
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

// ---------------------------------------------------------------- reactions

// Every reaction is padded to this many bytes before encryption, so the server can't tell
// 👍 from 👨‍👩‍👧, a custom emoji, a poll vote or an answer added to a poll (the longest, about
// 210 bytes) by its length. The server checks the size; it also takes reactions from before
// answers could be added, padded to 64.
export const REACTION_PLAINTEXT_BYTES = 256;

// Binds a reaction to its message, the person reacting and the conversation, so the server
// can't move it to another message or make it look like the other person's.
export function reactionContext(messageId, reactorId, senderId, recipientId) {
  return `${DM_REACTION_CONTEXT}|${messageId}|${reactorId}|${senderId}|${recipientId}`;
}

// -> "v1.<base64(iv || ciphertext)>", always the same length.
export async function encryptReaction(emoji, key, context) {
  const bytes = te.encode(emoji);
  if (bytes.length === 0 || bytes.length > REACTION_PLAINTEXT_BYTES || bytes.includes(0)) {
    throw new Error('Invalid reaction');
  }
  const padded = new Uint8Array(REACTION_PLAINTEXT_BYTES);
  padded.set(bytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(context) },
    key,
    padded
  );
  return MESSAGE_PREFIX + toBase64(concat(iv, new Uint8Array(ciphertext)));
}

export async function decryptReaction(envelope, key, context) {
  if (typeof envelope !== 'string' || !envelope.startsWith(MESSAGE_PREFIX)) {
    throw new Error('Unsupported reaction format');
  }
  const bytes = fromBase64(envelope.slice(MESSAGE_PREFIX.length));
  const padded = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: te.encode(context) },
    key,
    bytes.slice(12)
  ));
  const end = padded.indexOf(0);
  const emoji = td.decode(end === -1 ? padded : padded.slice(0, end));
  if (!emoji) throw new Error('Empty reaction');
  return emoji;
}

// ---------------------------------------------------------------- calls

// A DM call's media key: 32 random bytes, made by the caller. It reaches the other person
// encrypted with the conversation key, bound to the call and who's calling whom, so the server
// can't hand it to another call or reverse the roles. LiveKit's end-to-end encryption uses it.
export function generateCallKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function callKeyContext(callId, callerId, calleeId) {
  return `${CALL_KEY_CONTEXT}|${callId}|${callerId}|${calleeId}`;
}

export function encryptCallKey(callKey, conversationKey, context) {
  return encryptMessage(toBase64(callKey), conversationKey, context);
}

export async function decryptCallKey(envelope, conversationKey, context) {
  const key = fromBase64(await decryptMessage(envelope, conversationKey, context));
  if (key.length !== 32) throw new Error('Invalid call key');
  return key;
}

// ---------------------------------------------------------------- spellcheck dictionary

// Your spellcheck dictionary (spellcheck/personalDictionary.js) is encrypted like notes: with a
// key your own key pair derives, under its own purpose, so it's never a notes or DM key.
export function deriveDictionaryKey(myEncryptionPrivateKey, myEncryptionKey) {
  return deriveEcdhKey(myEncryptionPrivateKey, myEncryptionKey, DICTIONARY_KEY_CONTEXT);
}

export function dictionaryContext(userId) {
  return `${DICTIONARY_CONTEXT}|${userId}`;
}

// Padded to steps of this many bytes, so its size only says roughly how many words it holds;
// the server takes envelopes up to a little over the largest (server/dictionary.js).
export const DICTIONARY_PAD_BYTES = 1024;
export const DICTIONARY_MAX_BYTES = 48 * 1024;

// `words` (strings) -> "v1.<base64>". Throws when there are too many to fit.
export function encryptDictionary(words, key, userId) {
  const json = JSON.stringify({ v: 1, words });
  const size = te.encode(json).length;
  if (size > DICTIONARY_MAX_BYTES) return Promise.reject(new Error('Your dictionary is full'));
  // JSON allows trailing spaces.
  const padded = json + ' '.repeat(Math.ceil(size / DICTIONARY_PAD_BYTES) * DICTIONARY_PAD_BYTES - size);
  return encryptMessage(padded, key, dictionaryContext(userId));
}

export async function decryptDictionary(envelope, key, userId) {
  const data = JSON.parse(await decryptMessage(envelope, key, dictionaryContext(userId)));
  if (data?.v !== 1 || !Array.isArray(data.words)) throw new Error('Unsupported dictionary format');
  return data.words.filter((word) => typeof word === 'string');
}

// Decrypts a message's reactions into [{ id, user_id, emoji }], skipping any that fail.
export async function decryptReactions(msg, reactions, key) {
  const results = await Promise.all((reactions ?? []).map(async (r) => {
    try {
      const emoji = await decryptReaction(
        r.content, key, reactionContext(msg.id, r.user_id, msg.sender_id, msg.recipient_id)
      );
      return { id: r.id, user_id: r.user_id, emoji, timestamp: r.timestamp };
    } catch (e) {
      console.warn('Failed to decrypt reaction', r.id, e);
      return null;
    }
  }));
  return results.filter(Boolean);
}

// The other person in a DM, given one of the two participants.
function otherParticipant(msg, participantId) {
  return String(participantId) === String(msg.sender_id) ? msg.recipient_id : msg.sender_id;
}

// Decrypts one DM row from the server (with the message it replies to and its reactions)
// into { ...row, plaintext, parent_plaintext, reactions }; a "poll ended" row (`system`) has no
// plaintext of its own, and its poll's votes (`poll_reactions`) come decrypted too. Anything that fails to decrypt
// comes back as null (or is left out, for reactions) rather than throwing.
export async function decryptMessageRow(msg, key) {
  let plaintext = null;
  let parentPlaintext = null;

  // A "poll ended" row has no content of its own (see decryptPollEndRow).
  if (!msg.system) {
    try {
      plaintext = await decryptMessage(msg.content, key, dmContext(msg.sender_id, msg.recipient_id));
    } catch (e) {
      console.warn('Failed to decrypt message', msg.id, e);
    }
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

  const reactions = await decryptReactions(msg, msg.reactions, key);
  const row = { ...msg, plaintext, parent_plaintext: parentPlaintext, reactions };
  if (msg.system === 'poll_end') {
    // Its poll's votes, bound to the poll (the parent), not this row.
    const poll = { id: msg.parent_message_id, sender_id: msg.parent_sender_id, recipient_id: otherParticipant(msg, msg.parent_sender_id) };
    row.poll_reactions = await decryptReactions(poll, msg.poll_reactions, key);
  }
  return row;
}

// Decrypts a page of DM rows.
export function decryptMessagesBatch(messages, key) {
  return Promise.all(messages.map((msg) => decryptMessageRow(msg, key)));
}
