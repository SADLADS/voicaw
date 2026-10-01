import { loadEncryptionKey, loadIdentityKey, loadOwnPublicKeys } from './keyStore';
import { acceptContactKeys, checkContactKeys } from './contactKeys';
import { verifyEncryptionKey } from './encryptionService';
import {
  entryHash,
  generateGroupKey,
  groupKeyContext,
  importGroupKey,
  makeRecord,
  signRecord,
  unwrapGroupKey,
  verifyGroupLog,
  wrapGroupKey,
} from './groupCrypto';
import { createGroupRequest, fetchGroup, postEpoch, postLogEntry } from './groupService';

// A group DM as this device sees it, with its keys (see groupCrypto.js for the formats):
// - openGroup fetches it, replays and checks the membership log, checks each person's identity
//   key against the one this device pinned for them (as opening a DM does), and opens the
//   epoch keys it was given (only from epochs made by someone who was a member then).
// - currentEpoch returns the key to send with, making the next epoch first when the
//   membership changed since the last one (the next sender does that, lazily).
// - createGroup and changeMembership sign new log records with this device's identity key.
// New epoch keys only ever go to members taken from the checked log, each with the encryption
// key their log identity key signed: the server can't slip anyone in.

const MAX_ATTEMPTS = 3;

export class GroupKeyProblem extends Error {
  constructor(message, users = []) {
    super(message);
    this.users = users;
  }
}

// -> { detail, log, keys: Map epoch -> CryptoKey, problems: [{ user, kind }], encryptionKeyOf }
// `problems`: people whose key changed (`kind: 'changed'`, acceptable like in a DM) or doesn't
// match the log (`'mismatch'`: they'd have to be re-added). Throws GroupLogError if the log
// doesn't check out.
export async function openGroup(me, groupId) {
  const detail = await fetchGroup(groupId);
  const log = await verifyGroupLog(groupId, detail.log);
  const users = new Map(detail.users.map((u) => [u.id, u]));
  const own = await loadOwnPublicKeys();

  // Only current members matter here: former ones' keys are only used to open epochs they
  // made, which encryptionKeyOf checks against the log.
  const problems = [];
  for (const [userId, identityKey] of log.members) {
    const user = users.get(userId);
    if (userId === me.id) {
      if (own?.identityKey !== identityKey) problems.push({ user: user ?? { id: userId, username: me.username }, kind: 'mismatch' });
      continue;
    }
    if (!user || user.identity_key !== identityKey) {
      problems.push({ user: user ?? { id: userId, username: `#${userId}` }, kind: 'mismatch' });
      continue;
    }
    const check = await checkContactKeys(me.id, user);
    if (!check.encryptionKey) problems.push({ user, kind: check.status === 'changed' ? 'changed' : 'mismatch' });
  }

  // Someone's current encryption key, only if the identity key the log gives them signed it.
  async function encryptionKeyOf(userId) {
    const user = users.get(userId);
    const identityKey = log.identityKeys.get(userId);
    const ok = user && identityKey && await verifyEncryptionKey({
      identityKey,
      encryptionKey: user.encryption_key,
      encryptionKeySignature: user.encryption_key_signature,
    });
    if (!ok) throw new GroupKeyProblem(`Can't use ${user?.username ?? 'someone'}'s key`, [user]);
    return user.encryption_key;
  }

  const myKey = await loadEncryptionKey();
  const keys = new Map();
  for (const e of detail.epochs) {
    const membersThen = log.membersAt[e.log_seq];
    if (!membersThen?.has(e.creator_id) || !membersThen.has(me.id)) continue;
    try {
      const context = groupKeyContext(groupId, e.epoch, e.log_seq, e.creator_id, me.id);
      keys.set(e.epoch, await unwrapGroupKey(e.envelope, myKey, await encryptionKeyOf(e.creator_id), context));
    } catch (err) {
      console.warn(`Group ${groupId}: can't open the key of epoch ${e.epoch}`, err);
    }
  }
  return { detail, log, keys, problems, encryptionKeyOf };
}

// Every current member's copy of a fresh epoch key (by me), for the membership after log
// entry `logSeq`. -> { body (for the server), key (CryptoKey) }
async function makeEpoch(me, groupId, epoch, logSeq, memberIds, encryptionKeyOf) {
  const bytes = generateGroupKey();
  const myKey = await loadEncryptionKey();
  const envelopes = {};
  for (const userId of memberIds) {
    envelopes[userId] = await wrapGroupKey(bytes, myKey, await encryptionKeyOf(userId), groupKeyContext(groupId, epoch, logSeq, me.id, userId));
  }
  return { body: { epoch, logSeq, envelopes }, key: await importGroupKey(bytes) };
}

function refuseIfProblems(group) {
  if (group.problems.length) {
    throw new GroupKeyProblem(
      `Can't send until ${group.problems.map((p) => p.user.username).join(', ')}'s security key is sorted out.`,
      group.problems.map((p) => p.user)
    );
  }
}

// The epoch to send with now: { epoch, key, group } (group: the openGroup result it came
// from). Makes the next epoch when the members changed since the newest one.
export async function currentEpoch(me, groupId, opened = null) {
  let group = opened ?? await openGroup(me, groupId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const latest = group.detail.latest_epoch;
    const upToDate = latest && latest.log_seq === group.log.nextSeq - 1 && group.keys.has(latest.epoch);
    if (upToDate) return { epoch: latest.epoch, key: group.keys.get(latest.epoch), group };
    refuseIfProblems(group);
    const epoch = (latest?.epoch ?? 0) + 1;
    const made = await makeEpoch(me, groupId, epoch, group.log.nextSeq - 1, [...group.log.members.keys()], group.encryptionKeyOf);
    try {
      await postEpoch(groupId, made.body);
      group.keys.set(epoch, made.key);
      group.detail.latest_epoch = { epoch, log_seq: made.body.logSeq, creator_id: me.id };
      return { epoch, key: made.key, group };
    } catch (err) {
      if (err.response?.status !== 409) throw err;
      // Someone else made it first, or the members changed again: look again.
      group = await openGroup(me, groupId);
    }
  }
  throw new Error('The group keeps changing; try again.');
}

async function signedEntry(fields) {
  const record = makeRecord(fields);
  return { record, signature: await signRecord(record, await loadIdentityKey()) };
}

// A contact's row with keys this device trusts (pinned, as for a DM). Throws if their key
// changed or is broken.
async function trustedUser(me, user) {
  const check = await checkContactKeys(me.id, user);
  if (!check.encryptionKey) {
    throw new GroupKeyProblem(`${user.username}'s security key changed. Open your chat with them to review it.`, [user]);
  }
  return user;
}

// A new group with `others` (user rows with public keys, as in the DM list) and `name`
// (optional). -> the group's summary
export async function createGroup(me, others, name) {
  const groupId = crypto.randomUUID();
  const own = await loadOwnPublicKeys();
  const log = [];
  let prev = null;
  const add = async (fields) => {
    const entry = await signedEntry({ groupId, seq: log.length, prev, actor: me.id, ...fields });
    log.push(entry);
    prev = await entryHash(entry.record, entry.signature);
  };
  await add({ type: 'create', targetIdentityKey: own.identityKey });
  const people = [];
  for (const user of others) {
    await trustedUser(me, user);
    await add({ type: 'add', target: user.id, targetIdentityKey: user.identity_key });
    people.push(user);
  }
  const keyOf = async (userId) => (userId === me.id ? own.encryptionKey : people.find((p) => p.id === userId).encryption_key);
  const { body: epoch } = await makeEpoch(me, groupId, 1, log.length - 1, [me.id, ...people.map((p) => p.id)], keyOf);
  return createGroupRequest({ id: groupId, name: name?.trim() || null, log, epoch });
}

// Adds `user` (a row with public keys), removes them (the owner), or leaves (`type: 'leave'`,
// no user). An add or remove also makes the new epoch right away (a leaver can't: the next
// member to send does).
export async function changeMembership(me, groupId, type, user = null) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const group = await openGroup(me, groupId);
    if (type === 'add') await trustedUser(me, user);
    const target = type === 'leave' ? me.id : user.id;
    const entry = await signedEntry({
      groupId,
      seq: group.log.nextSeq,
      prev: group.log.prevHash,
      type,
      actor: me.id,
      target,
      targetIdentityKey: type === 'add' ? user.identity_key : null,
    });
    let epoch;
    if (type !== 'leave') {
      const members = new Set(group.log.members.keys());
      if (type === 'add') members.add(user.id);
      else members.delete(user.id);
      const keyOf = async (userId) => (userId === user.id && type === 'add' ? user.encryption_key : group.encryptionKeyOf(userId));
      if (!group.problems.length) {
        epoch = (await makeEpoch(me, groupId, (group.detail.latest_epoch?.epoch ?? 0) + 1, group.log.nextSeq, [...members], keyOf)).body;
      }
    }
    try {
      return await postLogEntry(groupId, entry, epoch);
    } catch (err) {
      if (err.response?.status !== 409) throw err;
    }
  }
  throw new Error('The group keeps changing; try again.');
}

// A signed `leave` entry for the group as it is now (deleting the account sends one per group).
export async function leaveEntry(me, groupId) {
  const group = await openGroup(me, groupId);
  return signedEntry({ groupId, seq: group.log.nextSeq, prev: group.log.prevHash, type: 'leave', actor: me.id, target: me.id });
}

// After a "key changed" warning: trust their new key (like accepting it in a DM).
export async function acceptChangedKeys(me, users) {
  for (const user of users) await acceptContactKeys(me.id, user);
}
