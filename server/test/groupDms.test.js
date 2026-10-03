import { objects, putMockObject } from './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { registerUser, loginUser } from './helpers/authFlow.js';
import { sealName, openName } from './helpers/groupNames.js';
import {
  importEncryptionPrivateKey,
  importIdentityPrivateKey,
  encryptMessage,
} from '../../client/src/services/encryptionService.js';
import {
  makeRecord,
  signRecord,
  entryHash,
  verifyGroupLog,
  generateGroupKey,
  wrapGroupKey,
  unwrapGroupKey,
  groupKeyContext,
  groupMessageContext,
  encryptGroupMessage,
  decryptGroupMessage,
  messageSignatureContext,
  encryptGroupReaction,
  reactionSignatureContext,
  groupReactionContext,
  sealGroupName,
  importGroupKey,
} from '../../client/src/services/groupCrypto.js';

const app = require('../index.js');
const voice = require('../voice.js');
const calls = require('../calls.js');
const db = require('../db.js');
const { cleanUpUploads } = require('../uploads.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'grp') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-groups-123';
  const { response: regRes, keys } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return {
    id: regRes.body.id,
    username,
    token: loginRes.body.token,
    keys,
    signingKey: await importIdentityPrivateKey(keys.private.identityKey),
    encryptionKey: await importEncryptionPrivateKey(keys.private.encryptionKey),
  };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

// A client's view of a group: builds signed records and epochs like the app does.
async function entry(actor, { groupId, seq, prev }, type, target = null) {
  const record = makeRecord({
    groupId, seq, prev, type, actor: actor.id,
    target: type === 'create' ? null : target?.id ?? null,
    targetIdentityKey: type === 'create' ? actor.keys.public.identityKey : type === 'add' ? target.keys.public.identityKey : null,
  });
  return { record, signature: await signRecord(record, actor.signingKey) };
}

// An epoch, carrying the group's name (as the server has its version; the creator signs a
// stand-in, the server can't tell; see 'lets people added read the name' for the real thing).
async function epochFor(creator, groupId, epoch, logSeq, members, { version, name = '' } = {}) {
  const key = generateGroupKey();
  const envelopes = {};
  for (const m of members) {
    envelopes[m.id] = await wrapGroupKey(key, creator.encryptionKey, m.keys.public.encryptionKey, groupKeyContext(groupId, epoch, logSeq, creator.id, m.id));
  }
  const nameVersion = version ?? (await api.get(creator, `/group-dms/${groupId}`)).body.name_version;
  const body = nameVersion
    ? { epoch, logSeq, envelopes, name: await sealName(creator, groupId, epoch, { keyBytes: key, name, version: nameVersion }), nameVersion }
    : { epoch, logSeq, envelopes };
  // The raw key, for tests that need it (not sent).
  return Object.defineProperty(body, 'keyBytes', { value: key, enumerable: false });
}

// The group's name as `user` reads it: { name, renamerId, version, ... } (checked).
async function readName(user, groupId) {
  const group = (await api.get(user, `/group-dms/${groupId}`)).body;
  return openName(group.name_ciphertext, await keyOf(user, groupId, group.name_epoch), groupId, group.name_epoch, group.users);
}

async function createGroup(owner, others, name = '') {
  const groupId = randomUUID();
  const log = [];
  let prev = null;
  for (const [seq, [type, target]] of [['create', null], ...others.map((o) => ['add', o])].entries()) {
    const e = await entry(owner, { groupId, seq, prev }, type, target);
    log.push(e);
    prev = await entryHash(e.record, e.signature);
  }
  const res = await api.post(owner, '/group-dms', {
    id: groupId, log, epoch: await epochFor(owner, groupId, 1, log.length - 1, [owner, ...others], { version: 1, name }),
  });
  return { groupId, res };
}

// The next record for the group as the server has it.
async function next(user, groupId) {
  const group = (await api.get(user, `/group-dms/${groupId}`)).body;
  const last = group.log.at(-1);
  return { group, groupId, seq: last.seq + 1, prev: await entryHash(last.record, last.signature) };
}

async function change(actor, groupId, type, target, epochMembers) {
  const at = await next(actor, groupId);
  const body = { entry: await entry(actor, at, type, target) };
  if (epochMembers) body.epoch = await epochFor(actor, groupId, (at.group.latest_epoch?.epoch ?? 0) + 1, at.seq, epochMembers);
  return api.post(actor, `/group-dms/${groupId}/log`, body);
}

async function keyOf(user, groupId, epoch) {
  const group = (await api.get(user, `/group-dms/${groupId}`)).body;
  const e = group.epochs.find((x) => x.epoch === epoch);
  if (!e) return null;
  const creator = group.users.find((u) => u.id === e.creator_id);
  return unwrapGroupKey(e.envelope, user.encryptionKey, creator.encryption_key, groupKeyContext(groupId, epoch, e.log_seq, e.creator_id, user.id));
}

// Sends `text` signed, as the app does (`extra`: more of the body, e.g. `uploads`).
async function send(user, groupId, text, extra = {}) {
  const group = (await api.get(user, `/group-dms/${groupId}`)).body;
  const epoch = group.latest_epoch.epoch;
  const key = await keyOf(user, groupId, epoch);
  const content = await encryptGroupMessage(
    text, key, groupMessageContext(groupId, epoch, user.id), user.signingKey,
    messageSignatureContext({ groupId, epoch, senderId: user.id })
  );
  return api.post(user, `/group-dms/${groupId}/messages`, { epoch, content, ...extra });
}

async function readAll(user, groupId) {
  const rows = (await api.get(user, `/group-dms/${groupId}/messages`)).body;
  const out = [];
  const group = (await api.get(user, `/group-dms/${groupId}`)).body;
  for (const m of rows) {
    const key = await keyOf(user, groupId, m.epoch);
    const sender = group.users.find((u) => u.id === m.sender_id);
    const { text, verified } = await decryptGroupMessage(
      m.content, key, groupMessageContext(groupId, m.epoch, m.sender_id), sender.identity_key,
      messageSignatureContext({ groupId, epoch: m.epoch, senderId: m.sender_id, replyTo: m.parent_message_id, editOf: m.edited ? m.id : null })
    );
    expect(verified).toBe(true);
    out.push(text);
  }
  return out;
}

describe('group DMs', () => {
  it('creates a group everyone in it can open, and whose log checks out', async () => {
    const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const beaEvents = listen(bea);
    const { groupId, res } = await createGroup(ann, [bea, cal], 'Trip');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: groupId, name: null, name_version: 1, name_epoch: 1, owner_id: ann.id, unread: 0 });
    expect(res.body.members.map((m) => m.id)).toEqual([ann.id, bea.id, cal.id]);
    expect(beaEvents.find((e) => e.type === 'group_dm_add').group.id).toBe(groupId);
    expect((await api.get(bea, '/group-dms')).body.map((g) => g.id)).toContain(groupId);

    const group = (await api.get(cal, `/group-dms/${groupId}`)).body;
    const log = await verifyGroupLog(groupId, group.log);
    expect([...log.members.keys()]).toEqual([ann.id, bea.id, cal.id]);
    expect(log.ownerId).toBe(ann.id);
    // Everyone's online status, for the member list.
    for (const u of group.users) expect(u).toHaveProperty('status', expect.any(String));

    expect((await send(bea, groupId, 'hello all')).status).toBe(201);
    expect(await readAll(cal, groupId)).toEqual(['hello all']);
    // The name is only readable in the group.
    expect(await readName(cal, groupId)).toMatchObject({ name: 'Trip', renamerId: ann.id, version: 1, initial: true });
    expect(JSON.stringify(group)).not.toContain('Trip');
  });

  it('refuses forged or broken changes', async () => {
    const [ann, bea, cal, dan] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal]);
    const at = await next(ann, groupId);

    // Signed by someone else's key.
    const forged = await entry(ann, at, 'add', dan);
    forged.signature = (await entry(bea, at, 'add', dan)).signature;
    expect((await api.post(ann, `/group-dms/${groupId}/log`, { entry: forged })).status).toBe(400);
    // Claiming to be someone else.
    expect((await api.post(bea, `/group-dms/${groupId}/log`, { entry: await entry(ann, at, 'add', dan) })).status).toBe(400);
    // A made-up identity key for the person added.
    const wrongKey = { ...dan, keys: { ...dan.keys, public: { ...dan.keys.public, identityKey: bea.keys.public.identityKey } } };
    expect((await api.post(ann, `/group-dms/${groupId}/log`, { entry: await entry(ann, at, 'add', wrongKey) })).status).toBe(400);
    // Out of sequence.
    expect((await api.post(ann, `/group-dms/${groupId}/log`, { entry: await entry(ann, { ...at, seq: at.seq + 1 }, 'add', dan) })).status).toBe(409);
    // Only the owner removes.
    expect((await change(bea, groupId, 'remove', cal)).status).toBe(403);
    // A group needs two other people.
    expect((await createGroup(ann, [bea])).res.status).toBe(400);
  });

  it("doesn't show new members what was said before they joined", async () => {
    const [ann, bea, cal, dan] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal]);
    await send(ann, groupId, 'before dan');
    const danEvents = listen(dan);
    // An add needs its epoch (whoever's added must be able to read the name).
    expect((await change(bea, groupId, 'add', dan)).status).toBe(400);
    expect((await change(bea, groupId, 'add', dan, [ann, bea, cal, dan])).status).toBe(200);
    expect(danEvents.find((e) => e.type === 'group_dm_add')).toBeTruthy();
    await send(cal, groupId, 'hi dan');

    // After a leave the old epoch no longer fits the members: a new one has to be made first.
    await change(cal, groupId, 'leave', cal);
    const stale = await send(ann, groupId, 'too soon');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_epoch');
    const at = await next(ann, groupId);
    // It carries the name.
    const { name: _name, ...nameless } = await epochFor(ann, groupId, 3, at.seq - 1, [ann, bea, dan]);
    expect((await api.post(ann, `/group-dms/${groupId}/epochs`, nameless)).status).toBe(400);
    const made = await api.post(ann, `/group-dms/${groupId}/epochs`, await epochFor(ann, groupId, 3, at.seq - 1, [ann, bea, dan]));
    expect(made.status).toBe(201);
    // Someone else racing for the same epoch loses.
    expect((await api.post(bea, `/group-dms/${groupId}/epochs`, await epochFor(bea, groupId, 3, at.seq - 1, [ann, bea, dan]))).status).toBe(409);
    await send(ann, groupId, 'still here');

    expect(await readAll(dan, groupId)).toEqual(['hi dan', 'still here']);
    expect(await keyOf(dan, groupId, 1)).toBeNull();
    expect(await readAll(ann, groupId)).toEqual(['before dan', 'hi dan', 'still here']);
  });

  it('lets the owner remove people and anyone leave; the owner leaving leaves no owner', async () => {
    const [ann, bea, cal, dan] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal, dan]);
    const calEvents = listen(cal);
    expect((await change(ann, groupId, 'remove', cal, [ann, bea, dan])).status).toBe(200);
    expect(calEvents.find((e) => e.type === 'group_dm_remove')).toEqual({ type: 'group_dm_remove', groupId });
    expect((await api.get(cal, `/group-dms/${groupId}`)).status).toBe(404);
    expect((await api.get(cal, `/group-dms/${groupId}/messages`)).status).toBe(404);

    expect((await change(ann, groupId, 'leave', ann)).status).toBe(200);
    const group = (await api.get(bea, `/group-dms/${groupId}`)).body;
    expect(group.owner_id).toBeNull();
    expect((await verifyGroupLog(groupId, group.log)).ownerId).toBeNull();
    // Nobody can remove anyone now.
    expect((await change(bea, groupId, 'remove', dan)).status).toBe(403);
    expect((await change(dan, groupId, 'leave', dan)).status).toBe(200);
    // The last one out: the group is gone.
    expect((await change(bea, groupId, 'leave', bea)).status).toBe(200);
    expect((await api.get(bea, '/group-dms')).body.map((g) => g.id)).not.toContain(groupId);
  });

  it("deletes the files a message lists when it's deleted, and the rest when everyone has left", async () => {
    const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const { groupId, res: created } = await createGroup(ann, [bea, cal]);
    expect(created.status).toBe(201);
    const keys = [];
    for (let i = 0; i < 2; i++) {
      const res = await api.get(ann, '/upload_file?type=application/octet-stream&size=10');
      keys.push(res.body.fileUrl.split('/uploads/')[1]);
      putMockObject('uploads', keys[i], Buffer.from('x'));
    }
    const first = await send(ann, groupId, 'a file', { uploads: [keys[0]] });
    expect(first.status).toBe(201);
    expect((await send(ann, groupId, 'another', { uploads: [keys[1]] })).status).toBe(201);
    expect((await send(ann, groupId, 'bad', { uploads: {} })).status).toBe(400);

    expect((await api.delete(ann, `/group-dm-messages/${first.body.id}`)).status).toBe(200);
    await cleanUpUploads();
    expect(keys.map((key) => objects.has(`uploads/${key}`))).toEqual([false, true]);

    await change(ann, groupId, 'leave', ann);
    await change(bea, groupId, 'leave', bea);
    await cleanUpUploads();
    expect(objects.has(`uploads/${keys[1]}`)).toBe(true);
    await change(cal, groupId, 'leave', cal);
    await cleanUpUploads();
    expect(objects.has(`uploads/${keys[1]}`)).toBe(false);
  });

  it('lets someone re-added read the times they were in, but not the gap', async () => {
    const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal]);
    await send(ann, groupId, 'first');
    await change(cal, groupId, 'leave', cal, null);
    let at = await next(ann, groupId);
    await api.post(ann, `/group-dms/${groupId}/epochs`, await epochFor(ann, groupId, 2, at.seq - 1, [ann, bea]));
    await send(ann, groupId, 'while cal was away');
    expect((await change(bea, groupId, 'add', cal, [ann, bea, cal])).status).toBe(200);
    await send(bea, groupId, 'welcome back');
    expect(await readAll(cal, groupId)).toEqual(['first', 'welcome back']);
  });

  it('counts unread, and lets only authors edit and delete', async () => {
    const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal]);
    const sent = (await send(ann, groupId, 'one')).body;
    await send(ann, groupId, 'two');
    expect((await api.get(bea, '/group-dms')).body.find((g) => g.id === groupId).unread).toBe(2);
    await api.post(bea, `/group-dms/${groupId}/read`, { messageId: sent.id });
    expect((await api.get(bea, '/group-dms')).body.find((g) => g.id === groupId).unread).toBe(1);

    expect((await api.put(bea, `/group-dm-messages/${sent.id}`, { content: 'v2.x' })).status).toBe(403);
    expect((await api.delete(bea, `/group-dm-messages/${sent.id}`)).status).toBe(403);
    // Unsigned (from an app older than signing): refused.
    expect((await api.put(ann, `/group-dm-messages/${sent.id}`, { content: 'v1.edited' })).body.error).toMatch(/update the app/);
    expect((await api.put(ann, `/group-dm-messages/${sent.id}`, { content: 'v2.edited' })).status).toBe(200);
    const key = await keyOf(bea, groupId, 1);
    const signedReaction = await encryptGroupReaction(
      '👍', key, groupReactionContext(groupId, sent.id, bea.id), bea.signingKey,
      reactionSignatureContext({ groupId, epoch: 1, messageId: sent.id, reactorId: bea.id })
    );
    const reaction = await api.post(bea, `/group-dm-messages/${sent.id}/reactions`, { content: signedReaction });
    expect(reaction.status).toBe(201);
    expect((await api.post(bea, `/group-dm-messages/${sent.id}/reactions`, { content: `v1.${'A'.repeat(124)}` })).status).toBe(400);
    expect((await api.post(bea, `/group-dm-messages/${sent.id}/reactions`, { content: 'v2.short' })).status).toBe(400);
    expect((await api.delete(ann, `/group-dm-reactions/${reaction.body.id}`)).status).toBe(404);
    expect((await api.delete(ann, `/group-dm-messages/${sent.id}`)).status).toBe(200);
    const outsider = await makeUser('out');
    expect((await api.get(outsider, `/group-dms/${groupId}/messages`)).status).toBe(404);
    expect((await api.post(outsider, `/group-dm-messages/${sent.id}/reactions`, { content: signedReaction })).status).toBe(404);
  });

  it('marks a group read up to its newest message; a muted group pushes nothing to whoever muted it', async () => {
    const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal]);
    await send(ann, groupId, 'one');
    await send(ann, groupId, 'two');
    expect((await api.post(bea, `/group-dms/${groupId}/read`, { latest: true })).status).toBe(200);
    expect((await api.get(bea, '/group-dms')).body.find((g) => g.id === groupId).unread).toBe(0);

    const subscribe = async (user) => {
      const endpoint = `https://push.test/${user.username}`;
      await api.post(user, '/save-subscription', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
      return endpoint;
    };
    await subscribe(bea);
    const calEndpoint = await subscribe(cal);
    const muted = await api.put(bea, `/conversation-settings/group/${groupId}`, { mute: { duration: null }, pinned: true });
    expect(muted.body).toMatchObject({ kind: 'group', target: groupId, muted: true });
    const since = sentPushes.length;
    await send(ann, groupId, 'three');
    await waitForPushes(1000, since, 300);
    expect(sentPushes.slice(since).map((p) => p.endpoint)).toEqual([calEndpoint]);
    expect((await api.put(ann, `/conversation-settings/group/${groupId}`, { pinned: true })).status).toBe(200);
    const outsider = await makeUser('out');
    expect((await api.put(outsider, `/conversation-settings/group/${groupId}`, { pinned: true })).status).toBe(404);
  });

  it('refuses unsigned new messages', async () => {
    const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal]);
    const key = await keyOf(ann, groupId, 1);
    const content = await encryptMessage('unsigned', key, groupMessageContext(groupId, 1, ann.id));
    const res = await api.post(ann, `/group-dms/${groupId}/messages`, { epoch: 1, content });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/update the app/);
  });

  describe('names', () => {
    // Renames as `user`, with the latest epoch: -> the response.
    async function rename(user, groupId, name, { version, initial = false } = {}) {
      const group = (await api.get(user, `/group-dms/${groupId}`)).body;
      const epoch = group.latest_epoch.epoch;
      const v = version ?? group.name_version + 1;
      const sealed = await sealName(user, groupId, epoch, { key: await keyOf(user, groupId, epoch), name, version: v, initial });
      return api.patch(user, `/group-dms/${groupId}`, { name: sealed, epoch, version: v, initial });
    }

    it('renames: encrypted, signed by the renamer, with a row in the timeline', async () => {
      const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
      const { groupId } = await createGroup(ann, [bea, cal], 'Trip');
      const events = listen(cal);
      const res = await rename(bea, groupId, 'Plans');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: null, name_version: 2, name_epoch: 1 });
      expect(events.find((e) => e.type === 'group_dm_update').group.name_version).toBe(2);
      expect(await readName(cal, groupId)).toMatchObject({ name: 'Plans', renamerId: bea.id, version: 2, initial: false });

      // The rename row: the same name, from bea; it can't be reacted to, pinned, deleted or replied to.
      const row = events.find((e) => e.type === 'group_dm_message_new').message;
      expect(row).toMatchObject({ system: 'group_name', sender_id: bea.id, epoch: 1 });
      const group = (await api.get(cal, `/group-dms/${groupId}`)).body;
      expect((await openName(row.content, await keyOf(cal, groupId, 1), groupId, 1, group.users)).name).toBe('Plans');
      expect((await api.delete(bea, `/group-dm-messages/${row.id}`)).status).toBe(403);
      expect((await api.put(cal, `/group-dm-messages/${row.id}/pin`)).status).toBe(403);
      expect((await api.post(cal, `/group-dms/${groupId}/messages`, { epoch: 1, content: 'v2.x', replyTo: row.id })).status).toBe(400);

      // Plaintext (an older app), a skipped or repeated version, or a stale epoch: refused.
      const plain = await api.patch(bea, `/group-dms/${groupId}`, { name: 'Plaintext' });
      expect(plain.status).toBe(400);
      expect(plain.body.error).toMatch(/update the app/);
      expect((await rename(ann, groupId, 'Again', { version: 2 })).status).toBe(409);
      expect((await rename(ann, groupId, 'Skip', { version: 4 })).status).toBe(409);
      await change(cal, groupId, 'leave', cal);
      expect((await rename(ann, groupId, 'Cal must not read this')).status).toBe(409);
    });

    it('lets people added read the name: the adder seals the renamer\'s signed name with the new key', async () => {
      const [ann, bea, cal, dan] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
      const { groupId } = await createGroup(ann, [bea, cal]);
      expect((await rename(bea, groupId, 'Plans')).status).toBe(200);

      // What the app does: open the current name and seal the same signed record for epoch 2.
      const current = await readName(ann, groupId);
      const at = await next(ann, groupId);
      const epoch = await epochFor(ann, groupId, 2, at.seq, [ann, bea, cal, dan]);
      const newKey = await importGroupKey(epoch.keyBytes);
      epoch.name = await sealGroupName(current.signed, newKey, groupId, 2);
      const added = await api.post(ann, `/group-dms/${groupId}/log`, { entry: await entry(ann, at, 'add', dan), epoch });
      expect(added.status).toBe(200);

      expect(await readName(dan, groupId)).toMatchObject({ name: 'Plans', renamerId: bea.id, version: 2 });
      // Dan doesn't see the rename from before he was in.
      expect((await api.get(dan, `/group-dms/${groupId}/messages`)).body).toEqual([]);
    });

    it("refuses an add whose epoch lost a race, keeping the log as it was", async () => {
      const [ann, bea, cal, dan] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
      const { groupId } = await createGroup(ann, [bea, cal]);
      const at = await next(ann, groupId);
      // Made for name version 1, but bea renames first.
      const epoch = await epochFor(ann, groupId, 2, at.seq, [ann, bea, cal, dan]);
      expect((await rename(bea, groupId, 'Plans')).status).toBe(200);
      const res = await api.post(ann, `/group-dms/${groupId}/log`, { entry: await entry(ann, at, 'add', dan), epoch });
      expect(res.status).toBe(409);
      const group = (await api.get(ann, `/group-dms/${groupId}`)).body;
      expect(group.log).toHaveLength(at.seq);
      expect(group.members.map((m) => m.id)).not.toContain(dan.id);
      expect((await api.get(dan, `/group-dms/${groupId}`)).status).toBe(404);
    });

    it('pushes the encrypted name and message, never plaintext', async () => {
      const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
      const { groupId } = await createGroup(ann, [bea, cal], 'Secret plans');
      const endpoint = `https://push.test/${bea.username}`;
      await api.post(bea, '/save-subscription', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
      const since = sentPushes.length;
      await send(ann, groupId, 'meet at noon');
      const [push] = (await waitForPushes(1, since)).filter((p) => p.endpoint === endpoint);
      expect(push.payload).toMatchObject({
        type: 'group', title: 'Group', groupId, senderId: ann.id, recipientId: bea.id, epoch: 1, nameEpoch: 1,
        body: `New message from ${ann.username}`,
      });
      expect(push.payload.ciphertext).toMatch(/^v2\./);
      const group = (await api.get(bea, `/group-dms/${groupId}`)).body;
      expect((await openName(push.payload.nameCiphertext, await keyOf(bea, groupId, 1), groupId, 1, group.users)).name).toBe('Secret plans');
      expect(JSON.stringify(push.payload)).not.toMatch(/Secret|noon/);
    });

    it('lets a member encrypt a name from before names were encrypted', async () => {
      const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
      const { groupId } = await createGroup(ann, [bea, cal]);
      await db.run("UPDATE group_dms SET name = 'Old name', name_ciphertext = NULL, name_epoch = NULL, name_version = 0 WHERE id = ?", [groupId]);
      expect((await api.get(bea, '/group-dms')).body.find((g) => g.id === groupId)).toMatchObject({ name: 'Old name', name_version: 0 });
      // Until then, epochs carry no name.
      await change(cal, groupId, 'leave', cal);
      const at = await next(ann, groupId);
      expect((await api.post(ann, `/group-dms/${groupId}/epochs`, await epochFor(ann, groupId, 2, at.seq - 1, [ann, bea]))).status).toBe(201);

      const events = listen(ann);
      expect((await rename(bea, groupId, 'Old name', { version: 1, initial: true })).status).toBe(200);
      expect((await api.get(ann, '/group-dms')).body.find((g) => g.id === groupId)).toMatchObject({ name: null, name_version: 1, name_epoch: 2 });
      expect(await readName(ann, groupId)).toMatchObject({ name: 'Old name', initial: true });
      // No rename row for it, and only once.
      expect(events.some((e) => e.type === 'group_dm_message_new')).toBe(false);
      expect((await rename(ann, groupId, 'Old name', { version: 1, initial: true })).status).toBe(409);
    });
  });

  describe('group calls', () => {
    const liveKit = [];
    const fakeRoomService = {
      removeParticipant: async (room, identity) => { liveKit.push(['remove', room, identity]); },
      deleteRoom: async (room) => { liveKit.push(['deleteRoom', room]); },
      updateParticipant: async () => {},
    };
    const startCall = (user, groupId, epoch = 1) =>
      api.post(user, `/group-dms/${groupId}/call`, { callId: randomUUID(), epoch, keyEnvelope: `v2.${'B'.repeat(168)}` });

    it('takes only signed call keys', async () => {
      voice.livekit.roomService = fakeRoomService;
      const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
      const { groupId } = await createGroup(ann, [bea, cal]);
      const post = (keyEnvelope) => api.post(ann, `/group-dms/${groupId}/call`, { callId: randomUUID(), epoch: 1, keyEnvelope });
      const old = await post(`v1.${'B'.repeat(100)}`);
      expect(old.status).toBe(400);
      expect(old.body.error).toMatch(/update the app/);
      expect((await post('plain key')).status).toBe(400);
      expect((await post(`v2.${'B'.repeat(300)}`)).status).toBe(400);
    });

    it('rings everyone else, lets them join any time, and ends when the last one leaves', async () => {
      voice.livekit.roomService = fakeRoomService;
      const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
      const { groupId } = await createGroup(ann, [bea, cal]);
      const [beaEvents, calEvents] = [listen(bea), listen(cal)];
      const res = await startCall(ann, groupId);
      expect(res.status).toBe(201);
      const callId = res.body.call.id;
      expect(res.body.call).toMatchObject({ group_id: groupId, participants: [ann.id], key_epoch: 1 });
      expect(res.body.call.ringing.sort()).toEqual([bea.id, cal.id].sort());
      expect(beaEvents.find((e) => e.type === 'call_incoming').call.id).toBe(callId);
      // One call per group: the second is told to join the first.
      const second = await startCall(bea, groupId);
      expect(second.status).toBe(409);
      expect(second.body.call.id).toBe(callId);
      // The group shows it.
      expect((await api.get(cal, `/group-dms/${groupId}`)).body.call.id).toBe(callId);

      expect((await api.post(bea, `/dm-calls/${callId}/accept`)).status).toBe(200);
      await api.post(cal, `/dm-calls/${callId}/decline`);
      const update = calEvents.filter((e) => e.type === 'call_update').at(-1).call;
      expect(update.participants.sort()).toEqual([ann.id, bea.id].sort());
      expect(update.ringing).toEqual([]);
      // Declined, but can still join later.
      expect((await api.post(cal, `/dm-calls/${callId}/accept`)).status).toBe(200);

      await api.delete(ann, `/dm-calls/${callId}`);
      expect(calls.calls.has(callId)).toBe(true);
      await api.delete(bea, `/dm-calls/${callId}`);
      await api.delete(cal, `/dm-calls/${callId}`);
      expect(calls.calls.has(callId)).toBe(false);
      expect(calEvents.find((e) => e.type === 'call_end')).toEqual({ type: 'call_end', id: callId, reason: 'ended' });
    });

    it('takes people removed from the group out of its call, and keeps outsiders out', async () => {
      voice.livekit.roomService = fakeRoomService;
      const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
      const outsider = await makeUser('out');
      const { groupId } = await createGroup(ann, [bea, cal]);
      const callId = (await startCall(ann, groupId)).body.call.id;
      await api.post(cal, `/dm-calls/${callId}/accept`);
      expect((await api.post(outsider, `/dm-calls/${callId}/accept`)).status).toBe(404);
      expect((await startCall(outsider, groupId)).status).toBe(404);

      await change(ann, groupId, 'remove', cal);
      expect(liveKit).toContainEqual(['remove', `call-${callId}`, String(cal.id)]);
      expect(calls.calls.get(callId).participants.has(cal.id)).toBe(false);
      expect((await api.post(cal, `/dm-calls/${callId}/accept`)).status).toBe(404);
      await api.delete(ann, `/dm-calls/${callId}`);
    });

    const callRows = async (user, groupId) =>
      (await api.get(user, `/group-dms/${groupId}/messages`)).body.filter((m) => m.system === 'call');
    const unreadIn = async (user, groupId) => (await api.get(user, '/group-dms')).body.find((g) => g.id === groupId).unread;

    it('logs a call nobody joined as missed, unread for the others', async () => {
      voice.livekit.roomService = fakeRoomService;
      const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
      const { groupId } = await createGroup(ann, [bea, cal]);
      const beaEvents = listen(bea);
      const callId = (await startCall(ann, groupId)).body.call.id;
      await api.post(cal, `/dm-calls/${callId}/decline`);
      await api.delete(ann, `/dm-calls/${callId}`);

      const [row] = await callRows(bea, groupId);
      expect(row).toMatchObject({ sender_id: ann.id, system: 'call', epoch: 1 });
      expect(JSON.parse(row.content)).toEqual({ v: 1, outcome: 'missed', duration: 0, joined: [ann.id] });
      expect(beaEvents.find((e) => e.type === 'group_dm_message_new').message.id).toBe(row.id);
      expect(await unreadIn(bea, groupId)).toBe(1);
      expect(await unreadIn(ann, groupId)).toBe(0);
    });

    it('logs a call someone joined with its length, read for those who were in it', async () => {
      voice.livekit.roomService = fakeRoomService;
      const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
      const { groupId } = await createGroup(ann, [bea, cal]);
      const callId = (await startCall(ann, groupId)).body.call.id;
      await api.post(bea, `/dm-calls/${callId}/accept`);
      calls.calls.get(callId).createdAt -= 61 * 1000;
      await api.delete(ann, `/dm-calls/${callId}`);
      await api.delete(bea, `/dm-calls/${callId}`);

      const [row] = await callRows(cal, groupId);
      const content = JSON.parse(row.content);
      expect(content).toMatchObject({ outcome: 'ended', joined: [ann.id, bea.id] });
      expect(content.duration).toBeGreaterThanOrEqual(61);
      expect(await unreadIn(bea, groupId)).toBe(0);
      expect(await unreadIn(cal, groupId)).toBe(1);

      expect((await api.delete(ann, `/group-dm-messages/${row.id}`)).status).toBe(403);
      expect((await api.put(ann, `/group-dm-messages/${row.id}`, { content: 'v2.x' })).status).toBe(403);
      expect((await api.put(bea, `/group-dm-messages/${row.id}/pin`)).status).toBe(403);
      expect((await api.post(bea, `/group-dm-messages/${row.id}/reactions`, { content: 'v2.x' })).status).toBe(403);
      expect((await api.post(bea, `/group-dms/${groupId}/messages`, { epoch: 1, content: 'v2.reply', replyTo: row.id })).body.error).toBe('Invalid reply');
    });

    it('needs the current epoch', async () => {
      voice.livekit.roomService = fakeRoomService;
      const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
      const { groupId } = await createGroup(ann, [bea, cal]);
      expect((await startCall(ann, groupId, 2)).status).toBe(409);
    });
  });
});

describe('group DM pins', () => {
  it('lets any member pin and unpin, and lists only pins they can read', async () => {
    const [ann, bea, cal, dan, eve] = [await makeUser(), await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal]);
    const before = (await send(ann, groupId, 'before dan')).body.id;
    const calEvents = listen(cal);

    const pinned = await api.put(bea, `/group-dm-messages/${before}/pin`);
    expect(pinned.status).toBe(200);
    expect(pinned.body).toEqual({ messageId: before, pinned_at: expect.any(Number), pinned_by: bea.id });
    expect(calEvents).toContainEqual(expect.objectContaining({ type: 'group_dm_message_pin', groupId, messageId: before, pinned_by: bea.id }));
    expect((await api.get(cal, `/group-dms/${groupId}/messages`)).body[0].pinned_by).toBe(bea.id);

    // Dan, added later, can't read the old message: not in his list, and he can't unpin it.
    await change(ann, groupId, 'add', dan, [ann, bea, cal, dan]);
    const after = (await send(dan, groupId, 'hi from dan')).body.id;
    expect((await api.put(dan, `/group-dm-messages/${after}/pin`)).status).toBe(200);
    expect((await api.get(dan, `/group-dms/${groupId}/pins`)).body.map((m) => m.id)).toEqual([after]);
    expect((await api.delete(dan, `/group-dm-messages/${before}/pin`)).status).toBe(404);
    expect((await api.get(cal, `/group-dms/${groupId}/pins`)).body.map((m) => m.id).sort()).toEqual([before, after].sort());

    // Outsiders get nothing.
    expect((await api.put(eve, `/group-dm-messages/${after}/pin`)).status).toBe(404);
    expect((await api.get(eve, `/group-dms/${groupId}/pins`)).status).toBe(404);

    expect((await api.delete(cal, `/group-dm-messages/${after}/pin`)).body.pinned_at).toBe(null);
    expect((await api.get(dan, `/group-dms/${groupId}/pins`)).body).toEqual([]);
  });
});

describe('group polls', () => {
  it('posts a "poll ended" row only to those who can read the poll, with its votes', async () => {
    const [ann, bea, cal, dan] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, dan]);
    const poll = (await send(ann, groupId, 'poll:v1:{"q":"x","multi":false,"d":3600,"o":[{"id":"aaaa1111","t":"a"}]}')).body;
    // Only the author registers it.
    expect((await api.post(bea, `/polls/group/${poll.id}/timer`, { duration: 3600 })).status).toBe(403);
    expect((await api.post(ann, `/polls/group/${poll.id}/timer`, { duration: 3600 })).body.ends_at).toBe(poll.timestamp + 3600);
    const vote = await api.post(bea, `/group-dm-messages/${poll.id}/reactions`, { content: 'v2.' + 'A'.repeat(signedReactionLength() - 3) });
    expect(vote.status).toBe(201);
    // Cal joins later: no key for the poll's epoch, so no row either.
    expect((await change(ann, groupId, 'add', cal, [ann, bea, dan, cal])).status).toBe(200);
    const events = listen(cal);
    const beaEvents = listen(bea);
    const ended = await api.post(ann, `/polls/group/${poll.id}/end`);
    expect(ended.status).toBe(200);
    const row = beaEvents.find((e) => e.type === 'group_dm_message_new')?.message;
    expect(row).toMatchObject({ id: ended.body.messageId, system: 'poll_end', parent_message_id: poll.id, sender_id: ann.id, content: '' });
    expect(row.parent_content).toBe(poll.content);
    expect(row.poll_reactions.map((r) => r.id)).toEqual([vote.body.id]);
    expect(events.some((e) => e.type === 'group_dm_message_new')).toBe(false);
    expect((await api.get(cal, `/group-dms/${groupId}/messages`)).body.some((m) => m.system)).toBe(false);
    // It can't be edited; deleting the poll takes it too.
    expect((await api.put(ann, `/group-dm-messages/${row.id}`, { content: poll.content })).status).toBe(403);
    await api.delete(ann, `/group-dm-messages/${poll.id}`);
    expect(beaEvents.filter((e) => e.type === 'group_dm_message_delete').map((e) => e.messageId)).toEqual([poll.id, row.id]);
  });
});

// A signed group reaction's length (signature + 64 padded bytes, encrypted).
function signedReactionLength() {
  return require('../config.js').getMaxEncryptedLength(64 + 64);
}
