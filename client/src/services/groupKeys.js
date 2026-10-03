import { loadEncryptionKey, loadIdentityKey, loadOwnPublicKeys } from './keyStore';
import { acceptContactKeys, checkContactKeys } from './contactKeys';
import { verifyEncryptionKey } from './encryptionService';
import {
  entryHash,
  generateGroupKey,
  groupKeyContext,
  importGroupKey,
  cleanGroupName,
  makeRecord,
  openGroupName,
  sealGroupName,
  signGroupName,
  signRecord,
  unwrapGroupKey,
  verifyGroupLog,
  wrapGroupKey,
} from './groupCrypto';
import { createGroupRequest, fetchGroup, patchGroupName, postEpoch, postLogEntry } from './groupService';
import { recallGroup, rememberGroup, rememberGroupName } from './groupCache';
import { t } from '../i18n';

// A group DM as this device sees it, with its keys (see groupCrypto.js for the formats):
// - openGroup fetches it, replays and checks the membership log, checks each person's identity
//   key against the one this device pinned for them (as opening a DM does), opens the epoch
//   keys it was given (only from epochs made by someone who was a member then) and the group's
//   name, and saves what it checked on the device (groupCache.js).
// - currentEpoch returns the key to send with, making the next epoch first when the
//   membership changed since the last one (the next sender does that, lazily).
// - createGroup and changeMembership sign new log records with this device's identity key.
// New epoch keys only ever go to members taken from the checked log, each with the encryption
// key their log identity key signed: the server can't slip anyone in.
// The name is encrypted with the latest epoch's key, so every new epoch carries it, encrypted
// again with the new key (the renamer's signed record, unchanged). An add always makes its
// epoch, so whoever makes one can always read the name.

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
    if (!ok) throw new GroupKeyProblem(user?.username ? t('groups.errors.cantUseKey', { name: user.username }) : t('groups.errors.cantUseSomeonesKey'), [user]);
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

  const name = await readName(me, groupId, detail, keys, log);
  const members = [...log.members.keys()].map((id) => {
    const user = users.get(id);
    return { id, name: user ? user.display_name || user.username : '' };
  });
  await rememberGroup(me.id, groupId, { keys, identityKeys: log.identityKeys, members, name: name?.legacy ? null : name });
  return { detail, log, keys, problems, encryptionKeyOf, name };
}

// The group's name, checked: { name ('' for none), version, renamerId, initial, signed } (the
// newest this device has seen: an older one from the server is ignored); { name, version: 0,
// legacy: true } for a plaintext name from before names were encrypted; null if it can't be
// read.
async function readName(me, groupId, detail, keys, log) {
  if (!detail.name_version) return { name: detail.name ?? '', version: 0, legacy: true };
  let name = null;
  const key = keys.get(detail.name_epoch);
  if (key) {
    try {
      name = await openGroupName(detail.name_ciphertext, key, groupId, detail.name_epoch, (id) => log.identityKeys.get(id));
    } catch (err) {
      console.warn(`Group ${groupId}: can't read its name`, err);
    }
  }
  const seen = (await recallGroup(me.id, groupId))?.name;
  if (seen && (!name || seen.version > name.version)) {
    if (name) console.warn(`Group ${groupId}: the server sent an older name than this device has seen`);
    return { ...seen, initial: false };
  }
  return name;
}

// What a new epoch carries: the current name for the server's version of it, or null for a
// group whose name isn't encrypted yet. Throws when it can't be read (then no epoch can be made).
function nameToCarry(group) {
  if (!group.detail.name_version) return null;
  if (!group.name?.signed) throw new GroupKeyProblem(t('groups.errors.cantReadName'));
  return { signed: group.name.signed, version: group.detail.name_version };
}

// Every current member's copy of a fresh epoch key (by me), for the membership after log
// entry `logSeq`, carrying the group's `name` (nameToCarry's). -> { body (for the server), key
// (CryptoKey) }
async function makeEpoch(me, groupId, epoch, logSeq, memberIds, encryptionKeyOf, name) {
  const bytes = generateGroupKey();
  const myKey = await loadEncryptionKey();
  const envelopes = {};
  for (const userId of memberIds) {
    envelopes[userId] = await wrapGroupKey(bytes, myKey, await encryptionKeyOf(userId), groupKeyContext(groupId, epoch, logSeq, me.id, userId));
  }
  const key = await importGroupKey(bytes);
  const body = { epoch, logSeq, envelopes };
  if (name) {
    body.name = await sealGroupName(name.signed, key, groupId, epoch);
    body.nameVersion = name.version;
  }
  return { body, key };
}

function refuseIfProblems(group) {
  if (group.problems.length) {
    throw new GroupKeyProblem(
      t('groups.errors.cantSend', { names: group.problems.map((p) => p.user.username).join(', ') }),
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
    const made = await makeEpoch(me, groupId, epoch, group.log.nextSeq - 1, [...group.log.members.keys()], group.encryptionKeyOf, nameToCarry(group));
    try {
      await postEpoch(groupId, made.body);
      group.keys.set(epoch, made.key);
      group.detail.latest_epoch = { epoch, log_seq: made.body.logSeq, creator_id: me.id };
      if (made.body.name) Object.assign(group.detail, { name_ciphertext: made.body.name, name_epoch: epoch });
      await rememberGroup(me.id, groupId, { keys: new Map([[epoch, made.key]]), identityKeys: group.log.identityKeys, name: group.name?.legacy ? null : group.name });
      return { epoch, key: made.key, group };
    } catch (err) {
      if (err.response?.status !== 409) throw err;
      // Someone else made it first, or the members changed again: look again.
      group = await openGroup(me, groupId);
    }
  }
  throw new Error(t('groups.errors.keepsChanging'));
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
    throw new GroupKeyProblem(t('groups.errors.keyChanged', { name: user.username }), [user]);
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
  // The first name ('' for none) is version 1, not shown as a rename.
  const signed = await signGroupName({ groupId, version: 1, renamerId: me.id, name, initial: true }, await loadIdentityKey());
  const { body: epoch } = await makeEpoch(me, groupId, 1, log.length - 1, [me.id, ...people.map((p) => p.id)], keyOf, { signed, version: 1 });
  // With the name it was given, so the list shows it straight away.
  return { ...(await createGroupRequest({ id: groupId, log, epoch })), name: cleanGroupName(name) };
}

// Adds `user` (a row with public keys), removes them (the owner), or leaves (`type: 'leave'`,
// no user). An add always makes the new epoch with it (so the person added can read the
// group's name), a remove does if it can; a leaver can't: the next member to send does.
export async function changeMembership(me, groupId, type, user = null) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const group = await openGroup(me, groupId);
    if (type === 'add') {
      await trustedUser(me, user);
      refuseIfProblems(group);
      nameToCarry(group);
    }
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
      const canCarryName = !group.detail.name_version || group.name?.signed;
      if (!group.problems.length && canCarryName) {
        epoch = (await makeEpoch(me, groupId, (group.detail.latest_epoch?.epoch ?? 0) + 1, group.log.nextSeq, [...members], keyOf, nameToCarry(group))).body;
      }
    }
    try {
      return await postLogEntry(groupId, entry, epoch);
    } catch (err) {
      if (err.response?.status !== 409) throw err;
    }
  }
  throw new Error(t('groups.errors.keepsChanging'));
}

// Renames the group (any member; '' clears the name): the name signed by me, encrypted with
// the current epoch (made first if the members changed, so nobody who's left reads it).
// `initial`: encrypting a name from before names were encrypted (no "renamed" line; nothing
// to do if another member already has).
export async function renameGroup(me, groupId, name, { initial = false, opened = null } = {}) {
  let group = opened;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await currentEpoch(me, groupId, group);
    group = current.group;
    if (initial && group.detail.name_version > 0) return null;
    const version = group.detail.name_version + 1;
    const signed = await signGroupName({ groupId, version, renamerId: me.id, name, initial }, await loadIdentityKey());
    try {
      return await patchGroupName(groupId, {
        name: await sealGroupName(signed, current.key, groupId, current.epoch), epoch: current.epoch, version, initial,
      });
    } catch (err) {
      if (err.response?.status !== 409) throw err;
      group = await openGroup(me, groupId);
    }
  }
  throw new Error(t('groups.errors.keepsChanging'));
}

// A group's name for the conversation list, from its summary (GET /group-dms): '' when it has
// none, null when it can't be read. Uses the keys saved on this device when it can, else opens
// the group (which checks it all again and saves them).
export async function groupNameOf(me, summary) {
  if (!summary.name_version) return summary.name ?? '';
  const saved = await recallGroup(me.id, summary.id);
  if (saved?.name && saved.name.version >= summary.name_version) return saved.name.name;
  const key = saved?.epochs[summary.name_epoch];
  if (key) {
    try {
      const name = await openGroupName(summary.name_ciphertext, key, summary.id, summary.name_epoch, (id) => saved.identityKeys[id]);
      await rememberGroupName(me.id, summary.id, name);
      return name.name;
    } catch {
      // Renamed by someone this device hasn't seen in the group yet, say: open it.
    }
  }
  return (await openGroup(me, summary.id)).name?.name ?? null;
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
