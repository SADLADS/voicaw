import {
  decryptMessage,
  decryptReaction,
  encryptMessage,
  fromBase64,
  REACTION_PLAINTEXT_BYTES,
  toBase64,
} from './encryptionService';

// Group DM cryptography (see docs/group-dms.md):
// - The membership log: every change is a record (JSON, fixed field order) that its author
//   signs with their identity key, naming the previous entry's hash. verifyGroupLog replays
//   it with the rules (anyone adds, the owner removes, you leave yourself), so the server
//   can't add or drop members unnoticed.
// - Epoch keys: 32 random bytes per key period, wrapped for each member with a key from ECDH
//   between the epoch's creator and that member (HKDF, its own context), bound to the group,
//   epoch, membership version, creator and member.
// - Messages, edits and reactions: AES-GCM with the epoch key, bound to the group, epoch and
//   sender (or message and reactor), and signed by the sender's identity key. Everyone in the
//   group has the epoch key, so without the signature a member working with the server could
//   post as someone else. The signature is inside the encryption (only members see it), in a
//   `v2.` envelope: "v2." + base64(IV || AES-GCM(signature (64 bytes) || content)). Messages
//   from before signing are `v1.` (plain encryptMessage / encryptReaction) and show as unsigned.

const te = new TextEncoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

const LOG_CONTEXT = 'voicaw/group-log/v1';
const KEY_WRAP_CONTEXT = 'voicaw/group-key-wrap/v1';
const GROUP_KEY_CONTEXT = 'voicaw/group-key/v1';
const GROUP_MESSAGE_CONTEXT = 'voicaw/group-msg/v1';
const GROUP_REACTION_CONTEXT = 'voicaw/group-reaction/v1';
const GROUP_CALL_KEY_CONTEXT = 'voicaw/group-call-key/v1';
const MESSAGE_SIGNATURE_CONTEXT = 'voicaw/group-msg-sig/v1';
const REACTION_SIGNATURE_CONTEXT = 'voicaw/group-reaction-sig/v1';

export const SIGNED_PREFIX = 'v2.';
// ECDSA P-256 signatures from WebCrypto are r || s.
export const SIGNATURE_BYTES = 64;

export const MAX_GROUP_MEMBERS = 10;

// ---------------------------------------------------------------- membership log

// A log record, as the exact JSON that gets signed. `type`: 'create' (seq 0, by the creator,
// `targetIdentityKey` their own key), 'add' (target and their identity key), 'remove' (the
// owner removes target), 'leave' (target = actor).
export function makeRecord({ groupId, seq, prev, type, actor, target = null, targetIdentityKey = null, at = Math.floor(Date.now() / 1000) }) {
  return JSON.stringify({ v: 1, group: groupId, seq, prev, type, actor, target, targetIdentityKey, at });
}

export async function signRecord(record, identityPrivateKey) {
  const signature = await crypto.subtle.sign(SIGN, identityPrivateKey, te.encode(`${LOG_CONTEXT}\n${record}`));
  return toBase64(new Uint8Array(signature));
}

export async function verifyRecord(record, signature, identityKey) {
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(identityKey), ECDSA, false, ['verify']);
    return await crypto.subtle.verify(SIGN, key, fromBase64(signature), te.encode(`${LOG_CONTEXT}\n${record}`));
  } catch {
    return false;
  }
}

// What the next record's `prev` is.
export async function entryHash(record, signature) {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(`${record}\n${signature}`));
  return toBase64(new Uint8Array(digest));
}

export class GroupLogError extends Error {}

// Replays the log (entries [{ seq, record, signature }], in order) for group `groupId`,
// checking every rule, signature and hash. Returns:
//   members: Map userId -> identity key (now), ownerId (null once the owner left),
//   identityKeys: Map userId -> the identity key the log gives them (latest),
//   membersAt: seq -> Set of member ids after that entry,
//   records: the parsed records, nextSeq, prevHash (for the next record).
// Throws GroupLogError if anything doesn't hold.
export async function verifyGroupLog(groupId, entries) {
  const members = new Map();
  const identityKeys = new Map();
  const membersAt = [];
  const records = [];
  let ownerId = null;
  let prevHash = null;
  for (const [i, entry] of entries.entries()) {
    let r;
    try {
      r = JSON.parse(entry.record);
    } catch {
      throw new GroupLogError(`Entry ${i} isn't readable`);
    }
    if (r.v !== 1 || r.group !== groupId || r.seq !== i || entry.seq !== i || r.prev !== prevHash) {
      throw new GroupLogError(`Entry ${i} is out of place`);
    }
    let signer;
    if (r.type === 'create') {
      if (i !== 0 || r.target !== null || !r.targetIdentityKey) throw new GroupLogError('Bad create');
      signer = r.targetIdentityKey;
    } else {
      if (i === 0) throw new GroupLogError('The log must start with its creation');
      if (!members.has(r.actor)) throw new GroupLogError(`Entry ${i} is by a non-member`);
      signer = members.get(r.actor);
      if (r.type === 'add') {
        if (members.has(r.target) || !r.targetIdentityKey) throw new GroupLogError(`Entry ${i} adds a member twice`);
        if (members.size >= MAX_GROUP_MEMBERS) throw new GroupLogError('Too many members');
      } else if (r.type === 'remove') {
        if (r.actor !== ownerId || !members.has(r.target) || r.target === r.actor) {
          throw new GroupLogError(`Entry ${i} removes someone without being the owner`);
        }
      } else if (r.type === 'leave') {
        if (r.target !== r.actor) throw new GroupLogError(`Entry ${i} makes someone else leave`);
      } else {
        throw new GroupLogError(`Entry ${i} has an unknown type`);
      }
    }
    if (!(await verifyRecord(entry.record, entry.signature, signer))) {
      throw new GroupLogError(`Entry ${i} has a bad signature`);
    }
    if (r.type === 'create') {
      members.set(r.actor, r.targetIdentityKey);
      identityKeys.set(r.actor, r.targetIdentityKey);
      ownerId = r.actor;
    } else if (r.type === 'add') {
      members.set(r.target, r.targetIdentityKey);
      identityKeys.set(r.target, r.targetIdentityKey);
    } else {
      members.delete(r.target);
      if (ownerId === r.target) ownerId = null;
    }
    membersAt.push(new Set(members.keys()));
    records.push(r);
    prevHash = await entryHash(entry.record, entry.signature);
  }
  if (records.length === 0) throw new GroupLogError('Empty log');
  return { members, ownerId, identityKeys, membersAt, records, nextSeq: records.length, prevHash };
}

// ---------------------------------------------------------------- epoch keys

export function generateGroupKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function importGroupKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function wrappingKey(myEncryptionPrivateKey, theirEncryptionKey) {
  const theirs = await crypto.subtle.importKey('raw', fromBase64(theirEncryptionKey), ECDH, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, myEncryptionPrivateKey, 256);
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(KEY_WRAP_CONTEXT) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function groupKeyContext(groupId, epoch, logSeq, creatorId, memberId) {
  return `${GROUP_KEY_CONTEXT}|${groupId}|${epoch}|${logSeq}|${creatorId}|${memberId}`;
}

// The epoch key for one member (by the epoch's creator).
export async function wrapGroupKey(keyBytes, myEncryptionPrivateKey, memberEncryptionKey, context) {
  return encryptMessage(toBase64(keyBytes), await wrappingKey(myEncryptionPrivateKey, memberEncryptionKey), context);
}

// A member opens their copy (with the creator's public encryption key). -> AES-GCM CryptoKey
export async function unwrapGroupKey(envelope, myEncryptionPrivateKey, creatorEncryptionKey, context) {
  const bytes = fromBase64(await decryptMessage(envelope, await wrappingKey(myEncryptionPrivateKey, creatorEncryptionKey), context));
  if (bytes.length !== 32) throw new Error('Invalid group key');
  return importGroupKey(bytes);
}

// ---------------------------------------------------------------- messages and calls

export function groupMessageContext(groupId, epoch, senderId) {
  return `${GROUP_MESSAGE_CONTEXT}|${groupId}|${epoch}|${senderId}`;
}

export function groupReactionContext(groupId, messageId, reactorId) {
  return `${GROUP_REACTION_CONTEXT}|${groupId}|${messageId}|${reactorId}`;
}

// A group call's key travels encrypted with the group's current epoch key.
export function groupCallKeyContext(callId, groupId, epoch, callerId) {
  return `${GROUP_CALL_KEY_CONTEXT}|${callId}|${groupId}|${epoch}|${callerId}`;
}

// ---------------------------------------------------------------- signatures

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// What a message's signature covers besides its text: the group, epoch, sender, the message it
// replies to, and for an edit the message edited (so an edit can't be moved to another
// message, or a reply to another parent).
export function messageSignatureContext({ groupId, epoch, senderId, replyTo = null, editOf = null }) {
  return `${MESSAGE_SIGNATURE_CONTEXT}|${groupId}|${epoch}|${senderId}|${replyTo ?? ''}|${editOf ?? ''}`;
}

export function reactionSignatureContext({ groupId, epoch, messageId, reactorId }) {
  return `${REACTION_SIGNATURE_CONTEXT}|${groupId}|${epoch}|${messageId}|${reactorId}`;
}

async function seal(bytes, epochKey, aad, signingKey, signatureContext) {
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN, signingKey, concatBytes(te.encode(`${signatureContext}\n`), bytes)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, epochKey, concatBytes(signature, bytes));
  return SIGNED_PREFIX + toBase64(concatBytes(iv, new Uint8Array(ciphertext)));
}

// -> { bytes, verified } (`verified` null when no identity key was given to check against).
async function open(envelope, epochKey, aad, identityKey, signatureContext) {
  const data = fromBase64(envelope.slice(SIGNED_PREFIX.length));
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, 12), additionalData: te.encode(aad) },
    epochKey,
    data.slice(12)
  ));
  const signature = plain.slice(0, SIGNATURE_BYTES);
  const bytes = plain.slice(SIGNATURE_BYTES);
  if (!identityKey) return { bytes, verified: null };
  let verified = false;
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(identityKey), ECDSA, false, ['verify']);
    verified = await crypto.subtle.verify(SIGN, key, signature, concatBytes(te.encode(`${signatureContext}\n`), bytes));
  } catch {
    verified = false;
  }
  return { bytes, verified };
}

// A group message (or edit), encrypted with the epoch key and signed with `signingKey` (the
// sender's identity private key).
export function encryptGroupMessage(text, epochKey, aad, signingKey, signatureContext) {
  return seal(te.encode(text), epochKey, aad, signingKey, signatureContext);
}

// -> { text, signed, verified }: `signed` false for a message from before signing (`v1.`);
// `verified` whether the signature is the sender's (`identityKey`: their key from the group's
// checked log; null skips the check, as for a reply's preview). Throws if it doesn't decrypt.
export async function decryptGroupMessage(envelope, epochKey, aad, identityKey, signatureContext) {
  if (typeof envelope === 'string' && envelope.startsWith(SIGNED_PREFIX)) {
    const { bytes, verified } = await open(envelope, epochKey, aad, identityKey, signatureContext);
    return { text: new TextDecoder().decode(bytes), signed: true, verified };
  }
  return { text: await decryptMessage(envelope, epochKey, aad), signed: false, verified: false };
}

// A reaction: the emoji padded to REACTION_PLAINTEXT_BYTES (every signed reaction is the same
// size), signed and encrypted.
export function encryptGroupReaction(emoji, epochKey, aad, signingKey, signatureContext) {
  const bytes = te.encode(emoji);
  if (bytes.length === 0 || bytes.length > REACTION_PLAINTEXT_BYTES || bytes.includes(0)) throw new Error('Invalid reaction');
  const padded = new Uint8Array(REACTION_PLAINTEXT_BYTES);
  padded.set(bytes);
  return seal(padded, epochKey, aad, signingKey, signatureContext);
}

// -> { emoji, signed, verified }
export async function decryptGroupReaction(envelope, epochKey, aad, identityKey, signatureContext) {
  if (typeof envelope === 'string' && envelope.startsWith(SIGNED_PREFIX)) {
    const { bytes, verified } = await open(envelope, epochKey, aad, identityKey, signatureContext);
    const end = bytes.indexOf(0);
    const emoji = new TextDecoder().decode(end === -1 ? bytes : bytes.slice(0, end));
    if (!emoji) throw new Error('Empty reaction');
    return { emoji, signed: true, verified };
  }
  return { emoji: await decryptReaction(envelope, epochKey, aad), signed: false, verified: false };
}

// ---------------------------------------------------------------- the group's name

// The name is a record the renamer signs with their identity key: JSON `{ v, group, version,
// renamer, name, initial, at }` (`version` counts renames from 1; `initial`: set at creation,
// or a name from before names were encrypted, so not shown as a rename), padded with zeros to
// NAME_RECORD_BYTES so every name is the same size. It's kept encrypted with the latest
// epoch's key, bound to the group and epoch: "v1." + base64(IV || AES-GCM(signature ||
// record)). Whoever makes a new epoch encrypts the same signed record again with the new key,
// so it stays the renamer's words.
const GROUP_NAME_CONTEXT = 'voicaw/group-name/v1';
const NAME_SIGNATURE_CONTEXT = 'voicaw/group-name-sig/v1';
const NAME_PREFIX = 'v1.';
export const NAME_RECORD_BYTES = 512;
export const MAX_GROUP_NAME = 100;

export function groupNameContext(groupId, epoch) {
  return `${GROUP_NAME_CONTEXT}|${groupId}|${epoch}`;
}

// What a name can be: trimmed, no control characters, at most MAX_GROUP_NAME characters.
export function cleanGroupName(name) {
  // eslint-disable-next-line no-control-regex
  return [...String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, MAX_GROUP_NAME).join('').trim();
}

// -> { record (padded bytes), signature (bytes) }: the signed name, to seal under an epoch key.
export async function signGroupName({ groupId, version, renamerId, name, initial = false, at = Math.floor(Date.now() / 1000) }, identityPrivateKey) {
  const json = te.encode(JSON.stringify({ v: 1, group: groupId, version, renamer: renamerId, name: cleanGroupName(name), initial, at }));
  if (json.length > NAME_RECORD_BYTES) throw new Error('That name is too long');
  const record = new Uint8Array(NAME_RECORD_BYTES);
  record.set(json);
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN, identityPrivateKey, concatBytes(te.encode(`${NAME_SIGNATURE_CONTEXT}\n`), record)));
  return { record, signature };
}

// The signed name encrypted with an epoch's key (for that epoch).
export async function sealGroupName(signed, epochKey, groupId, epoch) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(groupNameContext(groupId, epoch)) },
    epochKey,
    concatBytes(signed.signature, signed.record)
  );
  return NAME_PREFIX + toBase64(concatBytes(iv, new Uint8Array(ciphertext)));
}

// Opens an encrypted name and checks it: for this group, signed by its renamer
// (`identityKeyOf(userId)`: their identity key from the group's checked log). -> { name,
// version, renamerId, initial, at, signed } (`signed`, to seal again for a new epoch). Throws
// if it doesn't decrypt or check out.
export async function openGroupName(envelope, epochKey, groupId, epoch, identityKeyOf) {
  if (typeof envelope !== 'string' || !envelope.startsWith(NAME_PREFIX)) throw new Error('Not an encrypted name');
  const data = fromBase64(envelope.slice(NAME_PREFIX.length));
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, 12), additionalData: te.encode(groupNameContext(groupId, epoch)) },
    epochKey,
    data.slice(12)
  ));
  const signature = plain.slice(0, SIGNATURE_BYTES);
  const record = plain.slice(SIGNATURE_BYTES);
  const end = record.indexOf(0);
  const r = JSON.parse(new TextDecoder().decode(end === -1 ? record : record.slice(0, end)));
  if (r.v !== 1 || r.group !== groupId || !Number.isInteger(r.version) || r.version < 1 || typeof r.name !== 'string') {
    throw new Error('Not a name for this group');
  }
  const identityKey = identityKeyOf(r.renamer);
  if (!identityKey) throw new Error("The renamer isn't in the group's log");
  const key = await crypto.subtle.importKey('raw', fromBase64(identityKey), ECDSA, false, ['verify']);
  if (!(await crypto.subtle.verify(SIGN, key, signature, concatBytes(te.encode(`${NAME_SIGNATURE_CONTEXT}\n`), record)))) {
    throw new Error("The name's signature doesn't match its renamer");
  }
  return { name: r.name, version: r.version, renamerId: r.renamer, initial: r.initial === true, at: r.at, signed: { record, signature } };
}
