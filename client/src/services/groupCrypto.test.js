import { describe, it, expect, beforeAll } from 'vitest';
import { encryptMessage, generateUserKeys, importEncryptionPrivateKey, importIdentityPrivateKey } from './encryptionService';
import {
  callKeySignatureContext,
  cleanGroupName,
  decryptGroupCallKey,
  decryptGroupMessage,
  decryptGroupPicture,
  decryptGroupReaction,
  encryptGroupCallKey,
  encryptGroupMessage,
  encryptGroupPicture,
  encryptGroupReaction,
  entryHash,
  generateGroupKey,
  groupCallKeyContext,
  groupKeyContext,
  GroupLogError,
  groupMessageContext,
  groupReactionContext,
  importGroupKey,
  makeRecord,
  messageSignatureContext,
  openGroupName,
  reactionSignatureContext,
  sealGroupName,
  SIGNED_PREFIX,
  signGroupName,
  signRecord,
  unwrapGroupKey,
  verifyGroupLog,
  wrapGroupKey,
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

describe('signed messages', () => {
  let epochKey;
  beforeAll(async () => {
    epochKey = await importGroupKey(generateGroupKey());
  });
  const sigContext = (senderId, extra = {}) => messageSignatureContext({ groupId: GROUP, epoch: 1, senderId, ...extra });

  it("open with the sender's key, and only theirs", async () => {
    const [a, b] = people;
    const envelope = await encryptGroupMessage('hi all', epochKey, groupMessageContext(GROUP, 1, a.id), a.sign, sigContext(a.id));
    expect(envelope.startsWith(SIGNED_PREFIX)).toBe(true);
    expect(await decryptGroupMessage(envelope, epochKey, groupMessageContext(GROUP, 1, a.id), a.keys.public.identityKey, sigContext(a.id)))
      .toEqual({ text: 'hi all', signed: true, verified: true });
    expect((await decryptGroupMessage(envelope, epochKey, groupMessageContext(GROUP, 1, a.id), b.keys.public.identityKey, sigContext(a.id))).verified).toBe(false);
  });

  it('catch a member posting as someone else', async () => {
    // Bea has the epoch key, so she can encrypt "from Ann", but she can only sign as herself.
    const [a, b] = people;
    const forged = await encryptGroupMessage('send me money', epochKey, groupMessageContext(GROUP, 1, a.id), b.sign, sigContext(a.id));
    const result = await decryptGroupMessage(forged, epochKey, groupMessageContext(GROUP, 1, a.id), a.keys.public.identityKey, sigContext(a.id));
    expect(result.verified).toBe(false);
  });

  it('catch a reply moved to another message, and an edit moved to another message', async () => {
    const [a] = people;
    const aad = groupMessageContext(GROUP, 1, a.id);
    const reply = await encryptGroupMessage('yes!', epochKey, aad, a.sign, sigContext(a.id, { replyTo: 10 }));
    expect((await decryptGroupMessage(reply, epochKey, aad, a.keys.public.identityKey, sigContext(a.id, { replyTo: 11 }))).verified).toBe(false);
    const edit = await encryptGroupMessage('fixed', epochKey, aad, a.sign, sigContext(a.id, { editOf: 5 }));
    expect((await decryptGroupMessage(edit, epochKey, aad, a.keys.public.identityKey, sigContext(a.id, { editOf: 5 }))).verified).toBe(true);
    expect((await decryptGroupMessage(edit, epochKey, aad, a.keys.public.identityKey, sigContext(a.id, { editOf: 6 }))).verified).toBe(false);
    expect((await decryptGroupMessage(edit, epochKey, aad, a.keys.public.identityKey, sigContext(a.id))).verified).toBe(false);
  });

  it('still read messages from before signing, as unsigned', async () => {
    const [a] = people;
    const old = await encryptMessage('from before', epochKey, groupMessageContext(GROUP, 1, a.id));
    expect(await decryptGroupMessage(old, epochKey, groupMessageContext(GROUP, 1, a.id), a.keys.public.identityKey, sigContext(a.id)))
      .toEqual({ text: 'from before', signed: false, verified: false });
  });

  it('sign reactions too, at a fixed size', async () => {
    const [a, b] = people;
    const aad = groupReactionContext(GROUP, 7, a.id);
    const context = reactionSignatureContext({ groupId: GROUP, epoch: 1, messageId: 7, reactorId: a.id });
    const thumbs = await encryptGroupReaction('👍', epochKey, aad, a.sign, context);
    const family = await encryptGroupReaction('👨‍👩‍👧', epochKey, aad, a.sign, context);
    expect(thumbs.length).toBe(family.length);
    expect(await decryptGroupReaction(thumbs, epochKey, aad, a.keys.public.identityKey, context)).toEqual({ emoji: '👍', signed: true, verified: true });
    const forged = await encryptGroupReaction('👎', epochKey, aad, b.sign, context);
    expect((await decryptGroupReaction(forged, epochKey, aad, a.keys.public.identityKey, context)).verified).toBe(false);
  });
});

describe('signed call keys', () => {
  const CALL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const aad = (callerId) => groupCallKeyContext(CALL, GROUP, 1, callerId);
  const context = (callerId, callId = CALL) => callKeySignatureContext({ callId, groupId: GROUP, epoch: 1, callerId });

  it("open only with the caller's signature, and only for that call", async () => {
    const [a, b] = people;
    const epochKey = await importGroupKey(generateGroupKey());
    const callKey = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await encryptGroupCallKey(callKey, epochKey, aad(a.id), a.sign, context(a.id));
    expect(envelope.startsWith(SIGNED_PREFIX)).toBe(true);
    // The server checks this size.
    expect(envelope.length).toBe(171);
    expect(await decryptGroupCallKey(envelope, epochKey, aad(a.id), a.keys.public.identityKey, context(a.id))).toEqual(callKey);
    // Bea has the epoch key, so she can encrypt a call key "from Ann", but she can't sign as her.
    const forged = await encryptGroupCallKey(callKey, epochKey, aad(a.id), b.sign, context(a.id));
    await expect(decryptGroupCallKey(forged, epochKey, aad(a.id), a.keys.public.identityKey, context(a.id))).rejects.toThrow();
    // Nor move Ann's key to another call.
    await expect(decryptGroupCallKey(envelope, epochKey, aad(a.id), a.keys.public.identityKey, context(a.id, 'other'))).rejects.toThrow();
    // A caller who isn't in the log, and an unsigned key (as before), aren't accepted.
    await expect(decryptGroupCallKey(envelope, epochKey, aad(a.id), undefined, context(a.id))).rejects.toThrow();
    const unsigned = await encryptMessage(btoa(String.fromCharCode(...callKey)), epochKey, aad(a.id));
    await expect(decryptGroupCallKey(unsigned, epochKey, aad(a.id), a.keys.public.identityKey, context(a.id))).rejects.toThrow('Unsigned');
  });
});

describe('group names', () => {
  const identityKeyOf = (id) => people.find((p) => p.id === id)?.keys.public.identityKey;

  it('signs the name by its renamer, seals it per epoch, and keeps the signature when sealed again', async () => {
    const [a, b] = people;
    const epoch1 = await importGroupKey(generateGroupKey());
    const epoch2 = await importGroupKey(generateGroupKey());
    const signed = await signGroupName({ groupId: GROUP, version: 2, renamerId: a.id, name: '  Trip 🏕️  ' }, a.sign);
    const sealed = await sealGroupName(signed, epoch1, GROUP, 1);
    expect(await openGroupName(sealed, epoch1, GROUP, 1, identityKeyOf)).toMatchObject({ name: 'Trip 🏕️', version: 2, renamerId: a.id, initial: false });

    // b makes epoch 2 and carries a's name over: still a's words.
    const opened = await openGroupName(sealed, epoch1, GROUP, 1, identityKeyOf);
    const carried = await sealGroupName(opened.signed, epoch2, GROUP, 2);
    expect(await openGroupName(carried, epoch2, GROUP, 2, identityKeyOf)).toMatchObject({ name: 'Trip 🏕️', renamerId: a.id });

    // Bound to its epoch and group; a record b signed claiming to be a's doesn't check out.
    await expect(openGroupName(sealed, epoch1, GROUP, 2, identityKeyOf)).rejects.toThrow();
    await expect(openGroupName(sealed, epoch1, '99999999-2222-4333-8444-555555555555', 1, identityKeyOf)).rejects.toThrow();
    const forged = await signGroupName({ groupId: GROUP, version: 3, renamerId: a.id, name: 'Forged' }, b.sign);
    await expect(openGroupName(await sealGroupName(forged, epoch1, GROUP, 1), epoch1, GROUP, 1, identityKeyOf)).rejects.toThrow(/signature/);
  });

  it('gives every name the same size (as the server checks), and cleans it', async () => {
    const [a] = people;
    const key = await importGroupKey(generateGroupKey());
    const lengths = new Set();
    const picture = { id: '11111111-2222-4333-8444-555555555555', key: btoa(String.fromCharCode(...new Uint8Array(32))) };
    for (const name of ['', 'x', '"'.repeat(100), '🏕️'.repeat(60), '😀'.repeat(100)]) {
      for (const fields of [{}, { picture, change: 'picture', version: 999999, renamerId: 999999999, at: 9999999999 }]) {
        const signed = await signGroupName({ groupId: GROUP, version: 1, renamerId: a.id, name, ...fields }, a.sign);
        lengths.add((await sealGroupName(signed, key, GROUP, 1)).length);
      }
    }
    // server/groupDms.js NAME_CIPHERTEXT_LENGTHS
    expect([...lengths]).toEqual([3 + 4 * Math.ceil((12 + 64 + 768 + 16) / 3)]);
    expect(cleanGroupName(' a\u0000b\nc ')).toBe('abc');
    expect([...cleanGroupName('é'.repeat(150))]).toHaveLength(100);
  });

  it('names the group picture in the signed record, which opens only with its key, group and id', async () => {
    const [a] = people;
    const epoch = await importGroupKey(generateGroupKey());
    const image = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
    const { picture, data } = await encryptGroupPicture(image, GROUP);
    expect(data.startsWith('v1.')).toBe(true);
    const signed = await signGroupName({ groupId: GROUP, version: 3, renamerId: a.id, name: 'Trip', picture, change: 'picture' }, a.sign);
    const opened = await openGroupName(await sealGroupName(signed, epoch, GROUP, 1), epoch, GROUP, 1, identityKeyOf);
    expect(opened).toMatchObject({ name: 'Trip', picture, change: 'picture' });
    expect(await decryptGroupPicture(data, opened.picture, GROUP)).toEqual(image);

    // Another group's, another picture's id, or another key: doesn't open.
    await expect(decryptGroupPicture(data, picture, '99999999-2222-4333-8444-555555555555')).rejects.toThrow();
    await expect(decryptGroupPicture(data, { ...picture, id: '11111111-2222-4333-8444-555555555555' }, GROUP)).rejects.toThrow();
    const other = await encryptGroupPicture(image, GROUP);
    await expect(decryptGroupPicture(data, { ...picture, key: other.picture.key }, GROUP)).rejects.toThrow();

    // A record from before pictures: no picture, a rename.
    const old = await signGroupName({ groupId: GROUP, version: 2, renamerId: a.id, name: 'Old' }, a.sign);
    expect(await openGroupName(await sealGroupName(old, epoch, GROUP, 1), epoch, GROUP, 1, identityKeyOf)).toMatchObject({ picture: null, change: 'name' });
    await expect(signGroupName({ groupId: GROUP, version: 2, renamerId: a.id, name: 'x', picture: { id: 'nope', key: picture.key } }, a.sign)).rejects.toThrow();
  });
});
