import { decryptMessage, encryptMessage, fromBase64, toBase64 } from './encryptionService';

// Group DM cryptography (see CLAUDE.md, Group DMs):
// - The membership log: every change is a record (JSON, fixed field order) that its author
//   signs with their identity key, naming the previous entry's hash. verifyGroupLog replays
//   it with the rules (anyone adds, the owner removes, you leave yourself), so the server
//   can't add or drop members unnoticed.
// - Epoch keys: 32 random bytes per key period, wrapped for each member with a key from ECDH
//   between the epoch's creator and that member (HKDF, its own context), bound to the group,
//   epoch, membership version, creator and member.
// - Messages and reactions: AES-GCM with the epoch key (encryptMessage / encryptReaction),
//   bound to the group, epoch and sender (or message and reactor).

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
