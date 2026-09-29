import { describe, it, expect, beforeAll } from 'vitest';
import { generateUserKeys, importEncryptionPrivateKey, importIdentityPrivateKey } from './encryptionService';
import {
  entryHash,
  generateGroupKey,
  groupKeyContext,
  makeRecord,
  signRecord,
  unwrapGroupKey,
  verifyGroupLog,
  wrapGroupKey,
  GroupLogError,
} from './groupCrypto';

const GROUP = '11111111-2222-4333-8444-555555555555';
let people;

beforeAll(async () => {
  people = [];
  for (const id of [1, 2, 3, 4]) {
    const keys = await generateUserKeys();
    people.push({
      id,
      keys,
      sign: await importIdentityPrivateKey(keys.private.identityKey),
      decrypt: await importEncryptionPrivateKey(keys.private.encryptionKey),
    });
  }
});

// A log from steps [[actor, type, target]], each signed by `signer` (default: the actor).
async function buildLog(steps) {
  const entries = [];
  let prev = null;
  for (const [seq, [actor, type, target, signer = actor]] of steps.entries()) {
    const record = makeRecord({
      groupId: GROUP, seq, prev, type, actor: actor.id,
      target: type === 'create' ? null : target.id,
      targetIdentityKey: type === 'create' ? actor.keys.public.identityKey : type === 'add' ? target.keys.public.identityKey : null,
    });
    const signature = await signRecord(record, signer.sign);
    entries.push({ seq, record, signature });
    prev = await entryHash(record, signature);
  }
  return entries;
}

describe('verifyGroupLog', () => {
  it('replays a valid log', async () => {
    const [a, b, c, d] = people;
    const log = await verifyGroupLog(GROUP, await buildLog([
      [a, 'create'], [a, 'add', b], [b, 'add', c], [a, 'remove', c], [b, 'add', d], [a, 'leave', a],
    ]));
    expect([...log.members.keys()]).toEqual([b.id, d.id]);
    expect(log.ownerId).toBeNull();
    expect(log.membersAt[2]).toEqual(new Set([a.id, b.id, c.id]));
    expect(log.nextSeq).toBe(6);
  });

  it('rejects a change signed by someone else', async () => {
    const [a, b, c] = people;
    const entries = await buildLog([[a, 'create'], [a, 'add', b], [b, 'add', c, a]]);
    await expect(verifyGroupLog(GROUP, entries)).rejects.toThrow(GroupLogError);
  });

  it('rejects a removal by anyone but the owner, and a member added by an outsider', async () => {
    const [a, b, c, d] = people;
    await expect(verifyGroupLog(GROUP, await buildLog([[a, 'create'], [a, 'add', b], [a, 'add', c], [b, 'remove', c]]))).rejects.toThrow(/owner/);
    await expect(verifyGroupLog(GROUP, await buildLog([[a, 'create'], [a, 'add', b], [d, 'add', c]]))).rejects.toThrow(/non-member/);
  });

  it('rejects dropped, reordered or edited entries', async () => {
    const [a, b, c] = people;
    const entries = await buildLog([[a, 'create'], [a, 'add', b], [a, 'add', c]]);
    const dropped = [entries[0], { ...entries[2], seq: 1 }];
    await expect(verifyGroupLog(GROUP, dropped)).rejects.toThrow(GroupLogError);
    const edited = entries.map((e, i) => (i === 2 ? { ...e, record: e.record.replace(`"target":${c.id}`, '"target":4') } : e));
    await expect(verifyGroupLog(GROUP, edited)).rejects.toThrow(GroupLogError);
    await expect(verifyGroupLog('other-group', entries)).rejects.toThrow(GroupLogError);
  });

  it('never lets the owner come back after leaving', async () => {
    const [a, b, c] = people;
    const log = await verifyGroupLog(GROUP, await buildLog([[a, 'create'], [a, 'add', b], [a, 'add', c], [a, 'leave', a], [b, 'add', a]]));
    expect(log.members.has(a.id)).toBe(true);
    expect(log.ownerId).toBeNull();
  });
});

describe('epoch keys', () => {
  it('open only for that member, epoch and creator', async () => {
    const [a, b, c] = people;
    const key = generateGroupKey();
    const context = groupKeyContext(GROUP, 2, 5, a.id, b.id);
    const envelope = await wrapGroupKey(key, a.decrypt, b.keys.public.encryptionKey, context);
    const opened = await unwrapGroupKey(envelope, b.decrypt, a.keys.public.encryptionKey, context);
    expect(opened.type).toBe('secret');
    await expect(unwrapGroupKey(envelope, c.decrypt, a.keys.public.encryptionKey, context)).rejects.toThrow();
    await expect(unwrapGroupKey(envelope, b.decrypt, a.keys.public.encryptionKey, groupKeyContext(GROUP, 3, 5, a.id, b.id))).rejects.toThrow();
  });
});
