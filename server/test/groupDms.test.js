import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { registerUser, loginUser } from './helpers/authFlow.js';
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
} from '../../client/src/services/groupCrypto.js';

const app = require('../index.js');
const voice = require('../voice.js');
const calls = require('../calls.js');
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

async function epochFor(creator, groupId, epoch, logSeq, members) {
  const key = generateGroupKey();
  const envelopes = {};
  for (const m of members) {
    envelopes[m.id] = await wrapGroupKey(key, creator.encryptionKey, m.keys.public.encryptionKey, groupKeyContext(groupId, epoch, logSeq, creator.id, m.id));
  }
  return { epoch, logSeq, envelopes };
}

async function createGroup(owner, others, name = null) {
  const groupId = randomUUID();
  const log = [];
  let prev = null;
  for (const [seq, [type, target]] of [['create', null], ...others.map((o) => ['add', o])].entries()) {
    const e = await entry(owner, { groupId, seq, prev }, type, target);
    log.push(e);
    prev = await entryHash(e.record, e.signature);
  }
  const res = await api.post(owner, '/group-dms', {
    id: groupId, name, log, epoch: await epochFor(owner, groupId, 1, log.length - 1, [owner, ...others]),
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

// Sends `text` signed, as the app does.
async function send(user, groupId, text) {
  const group = (await api.get(user, `/group-dms/${groupId}`)).body;
  const epoch = group.latest_epoch.epoch;
  const key = await keyOf(user, groupId, epoch);
  const content = await encryptGroupMessage(
    text, key, groupMessageContext(groupId, epoch, user.id), user.signingKey,
    messageSignatureContext({ groupId, epoch, senderId: user.id })
  );
  return api.post(user, `/group-dms/${groupId}/messages`, { epoch, content });
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
    expect(res.body).toMatchObject({ id: groupId, name: 'Trip', owner_id: ann.id, unread: 0 });
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
    expect((await change(bea, groupId, 'add', dan)).status).toBe(200);
    expect(danEvents.find((e) => e.type === 'group_dm_add')).toBeTruthy();

    // The old epoch no longer fits the members: a new one has to be made first.
    const stale = await send(ann, groupId, 'too soon');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_epoch');
    const at = await next(ann, groupId);
    const made = await api.post(ann, `/group-dms/${groupId}/epochs`, await epochFor(ann, groupId, 2, at.seq - 1, [ann, bea, cal, dan]));
    expect(made.status).toBe(201);
    // Someone else racing for the same epoch loses.
    expect((await api.post(bea, `/group-dms/${groupId}/epochs`, await epochFor(bea, groupId, 2, at.seq - 1, [ann, bea, cal, dan]))).status).toBe(409);
    await send(cal, groupId, 'hi dan');

    expect(await readAll(dan, groupId)).toEqual(['hi dan']);
    expect(await keyOf(dan, groupId, 1)).toBeNull();
    expect(await readAll(ann, groupId)).toEqual(['before dan', 'hi dan']);
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

  it('lets someone re-added read the times they were in, but not the gap', async () => {
    const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal]);
    await send(ann, groupId, 'first');
    await change(cal, groupId, 'leave', cal, null);
    let at = await next(ann, groupId);
    await api.post(ann, `/group-dms/${groupId}/epochs`, await epochFor(ann, groupId, 2, at.seq - 1, [ann, bea]));
    await send(ann, groupId, 'while cal was away');
    await change(bea, groupId, 'add', cal, [ann, bea, cal]);
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

  it('refuses unsigned new messages', async () => {
    const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal]);
    const key = await keyOf(ann, groupId, 1);
    const content = await encryptMessage('unsigned', key, groupMessageContext(groupId, 1, ann.id));
    const res = await api.post(ann, `/group-dms/${groupId}/messages`, { epoch: 1, content });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/update the app/);
  });

  it('renames', async () => {
    const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const { groupId } = await createGroup(ann, [bea, cal]);
    const events = listen(cal);
    expect((await api.patch(bea, `/group-dms/${groupId}`, { name: '  Plans  ' })).body.name).toBe('Plans');
    expect(events.find((e) => e.type === 'group_dm_update').group.name).toBe('Plans');
  });

  describe('group calls', () => {
    const liveKit = [];
    const fakeRoomService = {
      removeParticipant: async (room, identity) => { liveKit.push(['remove', room, identity]); },
      deleteRoom: async (room) => { liveKit.push(['deleteRoom', room]); },
      updateParticipant: async () => {},
    };
    const startCall = (user, groupId, epoch = 1) =>
      api.post(user, `/group-dms/${groupId}/call`, { callId: randomUUID(), epoch, keyEnvelope: `v1.${'B'.repeat(100)}` });

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
