import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const own = vi.hoisted(() => ({ person: null }));
vi.mock('./keyStore', () => ({
  loadEncryptionKey: async () => own.person.decrypt,
  loadIdentityKey: async () => own.person.sign,
  loadOwnPublicKeys: async () => own.person.keys.public,
}));
vi.mock('./contactKeys', () => ({
  checkContactKeys: async (_me, user) => ({ status: 'trusted', encryptionKey: user.encryption_key }),
  acceptContactKeys: async () => {},
}));
vi.mock('./groupService', () => ({
  fetchGroup: vi.fn(),
  postEpoch: vi.fn(async () => ({})),
  createGroupRequest: vi.fn(),
  patchGroupName: vi.fn(),
  postLogEntry: vi.fn(),
}));

import { currentEpoch, epochStillPrivate, groupProfileOf, openGroup } from './groupKeys';
import { fetchGroup, postEpoch } from './groupService';
import { forgetGroups } from './groupCache';
import { generateUserKeys, importEncryptionPrivateKey, importIdentityPrivateKey } from './encryptionService';
import {
  entryHash, generateGroupKey, groupKeyContext, GroupLogError, importGroupKey, makeRecord, sealGroupName, signGroupName, signRecord, wrapGroupKey,
} from './groupCrypto';
import { t } from '../i18n';

const GROUP = '11111111-2222-4333-8444-555555555555';
let a;
let b;
let c;
let d;

beforeAll(async () => {
  const people = [];
  for (const id of [1, 2, 3, 4]) {
    const keys = await generateUserKeys();
    people.push({
      id,
      keys,
      sign: await importIdentityPrivateKey(keys.private.identityKey),
      decrypt: await importEncryptionPrivateKey(keys.private.encryptionKey),
      row: {
        id, username: `p${id}`, identity_key: keys.public.identityKey, encryption_key: keys.public.encryptionKey,
        encryption_key_signature: keys.public.encryptionKeySignature,
      },
    });
  }
  [a, b, c, d] = people;
});

beforeEach(async () => {
  vi.clearAllMocks();
  await forgetGroups();
  own.person = b;
});

// A log from steps [[actor, type, target]].
async function buildLog(steps) {
  const entries = [];
  let prev = null;
  for (const [seq, [actor, type, target]] of steps.entries()) {
    const record = makeRecord({
      groupId: GROUP, seq, prev, type, actor: actor.id,
      target: type === 'create' ? null : target.id,
      targetIdentityKey: type === 'create' ? actor.keys.public.identityKey : type === 'add' ? target.keys.public.identityKey : null,
    });
    const signature = await signRecord(record, actor.sign);
    entries.push({ seq, record, signature });
    prev = await entryHash(record, signature);
  }
  return entries;
}

// Epoch `epoch` made by `creator` after log entry `logSeq`, wrapped for `members`.
async function makeEpoch(epoch, logSeq, creator, members) {
  const bytes = generateGroupKey();
  const envelopes = {};
  for (const m of members) {
    envelopes[m.id] = await wrapGroupKey(bytes, creator.decrypt, m.keys.public.encryptionKey, groupKeyContext(GROUP, epoch, logSeq, creator.id, m.id));
  }
  return { epoch, logSeq, creator, envelopes, key: await importGroupKey(bytes) };
}

// What GET /group-dms/:id would give b.
function detailFor(log, epochs, extra = {}) {
  const last = epochs.at(-1);
  return {
    log,
    users: [a, b, c, d].map((p) => p.row),
    epochs: epochs.filter((e) => e.envelopes[b.id]).map((e) => ({ epoch: e.epoch, log_seq: e.logSeq, creator_id: e.creator.id, envelope: e.envelopes[b.id] })),
    latest_epoch: last ? { epoch: last.epoch, log_seq: last.logSeq, creator_id: last.creator.id } : null,
    name_version: 0,
    ...extra,
  };
}

const steps = () => [[a, 'create'], [a, 'add', b], [a, 'add', c], [a, 'remove', c]];

describe('openGroup: a log cut short', () => {
  it('refuses a log shorter than one this device has seen (a removal hidden)', async () => {
    const full = await buildLog(steps());
    fetchGroup.mockResolvedValue(detailFor(full, []));
    await openGroup(b, GROUP);

    fetchGroup.mockResolvedValue(detailFor(full.slice(0, 3), []));
    await expect(openGroup(b, GROUP)).rejects.toThrow(new GroupLogError(t('groups.errors.logRolledBack')));
    // Asked twice: another tab may only just have saved the longer one.
    expect(fetchGroup).toHaveBeenCalledTimes(3);
  });

  it('refuses a different log, and takes one that carries on from the one seen', async () => {
    const long = await buildLog([...steps(), [a, 'add', d]]);
    fetchGroup.mockResolvedValue(detailFor(long.slice(0, 3), []));
    await openGroup(b, GROUP);

    const other = await buildLog([[a, 'create'], [a, 'add', b], [a, 'add', d], [a, 'remove', d]]);
    fetchGroup.mockResolvedValue(detailFor(other, []));
    await expect(openGroup(b, GROUP)).rejects.toThrow(GroupLogError);

    fetchGroup.mockResolvedValue(detailFor(long, []));
    const group = await openGroup(b, GROUP);
    expect([...group.log.members.keys()]).toEqual([a.id, b.id, d.id]);
  });

  it('takes the same log again after the first one, and a longer one after a retry', async () => {
    const full = await buildLog(steps());
    fetchGroup.mockResolvedValue(detailFor(full.slice(0, 3), []));
    await openGroup(b, GROUP);
    fetchGroup.mockResolvedValue(detailFor(full.slice(0, 3), []));
    await openGroup(b, GROUP);
    fetchGroup.mockResolvedValueOnce(detailFor(full.slice(0, 2), [])).mockResolvedValueOnce(detailFor(full, []));
    await expect(openGroup(b, GROUP)).resolves.toBeTruthy();
  });
});

describe('currentEpoch: the epoch to send with', () => {
  it("goes by what's bound into each key, not the server's latest_epoch", async () => {
    const log = await buildLog(steps());
    const before = await makeEpoch(1, 2, a, [a, b, c]);
    const after = await makeEpoch(2, 3, a, [a, b]);
    // The server names the epoch c has as made after c's removal.
    fetchGroup.mockResolvedValue(detailFor(log, [before, after], { latest_epoch: { epoch: 1, log_seq: 3, creator_id: a.id } }));
    const { epoch } = await currentEpoch(b, GROUP);
    expect(epoch).toBe(2);
    expect(postEpoch).not.toHaveBeenCalled();
  });

  it("makes a new epoch for the members there are when there's none since the last change", async () => {
    const log = await buildLog(steps());
    const before = await makeEpoch(1, 2, a, [a, b, c]);
    fetchGroup.mockResolvedValue(detailFor(log, [before], { latest_epoch: { epoch: 1, log_seq: 3, creator_id: a.id } }));
    const { epoch } = await currentEpoch(b, GROUP);
    expect(epoch).toBe(2);
    expect(postEpoch).toHaveBeenCalledTimes(1);
    const body = postEpoch.mock.calls[0][1];
    expect(body).toMatchObject({ epoch: 2, logSeq: 3 });
    expect(Object.keys(body.envelopes).map(Number).sort()).toEqual([a.id, b.id]);
  });
});

describe('epochStillPrivate', () => {
  it('is false once anyone the key was made for has left, and not changed by additions', async () => {
    const log = await buildLog([...steps().slice(0, 3), [a, 'add', d]]);
    const epoch = await makeEpoch(1, 2, a, [a, b, c]);
    fetchGroup.mockResolvedValue(detailFor(log, [epoch]));
    expect(epochStillPrivate(await openGroup(b, GROUP), 1)).toBe(true);

    await forgetGroups();
    fetchGroup.mockResolvedValue(detailFor(await buildLog(steps()), [epoch]));
    const group = await openGroup(b, GROUP);
    expect(epochStillPrivate(group, 1)).toBe(false);
    expect(epochStillPrivate(group, 7)).toBe(false);
  });
});

describe('group names', () => {
  it("never shows a plaintext name from the server", async () => {
    const log = await buildLog(steps().slice(0, 3));
    fetchGroup.mockResolvedValue(detailFor(log, [], { name: 'Read this', name_version: 0 }));
    const group = await openGroup(b, GROUP);
    expect(group.name).toBeNull();
    expect(await groupProfileOf(b, { id: GROUP, name: 'Read this', name_version: 0 })).toEqual({ name: '', picture: null });
  });

  it('keeps the signed name it has seen when the server leaves it out', async () => {
    const log = await buildLog(steps().slice(0, 3));
    const epoch = await makeEpoch(1, 2, a, [a, b, c]);
    const signed = await signGroupName({ groupId: GROUP, version: 1, renamerId: a.id, name: 'Trip', initial: true }, a.sign);
    const nameCiphertext = await sealGroupName(signed, epoch.key, GROUP, 1);
    fetchGroup.mockResolvedValue(detailFor(log, [epoch], { name_version: 1, name_epoch: 1, name_ciphertext: nameCiphertext }));
    expect((await openGroup(b, GROUP)).name.name).toBe('Trip');

    fetchGroup.mockResolvedValue(detailFor(log, [epoch], { name: 'Read this', name_version: 0 }));
    expect((await openGroup(b, GROUP)).name.name).toBe('Trip');
    expect(await groupProfileOf(b, { id: GROUP, name: 'Read this', name_version: 0 })).toMatchObject({ name: 'Trip' });
  });
});
