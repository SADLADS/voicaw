import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { registerUser, loginUser } from './helpers/authFlow.js';
import { importEncryptionPrivateKey, importIdentityPrivateKey } from '../../client/src/services/encryptionService.js';
import { makeRecord, signRecord, entryHash, generateGroupKey, wrapGroupKey, groupKeyContext } from '../../client/src/services/groupCrypto.js';

const app = require('../index.js');
const { PERMISSIONS: P } = require('../permissions.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'typer') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-typing-123';
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
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};
const typing = (user, chatId) => api.post(user, '/typing', { chatId });

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}
const typingEvents = (events) => events.filter((e) => e.type === 'typing');

async function createGroup(owner, others) {
  const groupId = randomUUID();
  const log = [];
  let prev = null;
  for (const [seq, [type, target]] of [['create', null], ...others.map((o) => ['add', o])].entries()) {
    const record = makeRecord({
      groupId, seq, prev, type, actor: owner.id,
      target: type === 'create' ? null : target.id,
      targetIdentityKey: type === 'create' ? owner.keys.public.identityKey : target.keys.public.identityKey,
    });
    const e = { record, signature: await signRecord(record, owner.signingKey) };
    log.push(e);
    prev = await entryHash(e.record, e.signature);
  }
  const key = generateGroupKey();
  const envelopes = {};
  for (const m of [owner, ...others]) {
    envelopes[m.id] = await wrapGroupKey(key, owner.encryptionKey, m.keys.public.encryptionKey, groupKeyContext(groupId, 1, log.length - 1, owner.id, m.id));
  }
  const res = await api.post(owner, '/group-dms', { id: groupId, log, epoch: { epoch: 1, logSeq: log.length - 1, envelopes } });
  expect(res.status).toBe(201);
  return groupId;
}

describe('typing', () => {
  it('tells the other person in a DM, under the chat id they know it by', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const aliceEvents = listen(alice);
    const bobEvents = listen(bob);
    expect((await typing(alice, String(bob.id))).status).toBe(204);
    expect(typingEvents(bobEvents)).toEqual([{ type: 'typing', chatId: String(alice.id), userId: alice.id }]);
    expect(typingEvents(aliceEvents)).toEqual([]);
  });

  it('sends at most every second per chat, saying when it was too soon', async () => {
    const [alice, bob, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const [bobEvents, calEvents] = [bob, cal].map(listen);
    expect((await typing(alice, bob.id)).status).toBe(204);
    expect((await typing(alice, bob.id)).status).toBe(429);
    expect((await typing(alice, cal.id)).status).toBe(204);
    expect(typingEvents(bobEvents)).toHaveLength(1);
    expect(typingEvents(calEvents)).toHaveLength(1);
  });

  it("refuses notes, unknown people, nonsense and logged-out callers", async () => {
    const alice = await makeUser();
    expect((await typing(alice, String(alice.id))).status).toBe(404);
    expect((await typing(alice, '999999')).status).toBe(404);
    expect((await typing(alice, 'notes')).status).toBe(404);
    expect((await typing(alice, 'guild-1')).status).toBe(404);
    expect((await api.post(alice, '/typing', {})).status).toBe(404);
    expect((await request(app).post('/api/typing').send({ chatId: '1' })).status).toBe(401);
  });

  it('tells the rest of a group DM, and not outsiders', async () => {
    const [ann, bea, cal, eve] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const groupId = await createGroup(ann, [bea, cal]);
    const [annEvents, beaEvents, calEvents, eveEvents] = [ann, bea, cal, eve].map(listen);
    expect((await typing(bea, `group-${groupId}`)).status).toBe(204);
    const expected = [{ type: 'typing', chatId: `group-${groupId}`, userId: bea.id }];
    expect(typingEvents(annEvents)).toEqual(expected);
    expect(typingEvents(calEvents)).toEqual(expected);
    expect(typingEvents(beaEvents)).toEqual([]);
    expect((await typing(eve, `group-${groupId}`)).status).toBe(404);
    expect(typingEvents(eveEvents)).toEqual([]);
  });

  it('tells who can see a guild channel, if the typer may send there', async () => {
    const [owner, member, outsider] = [await makeUser(), await makeUser(), await makeUser()];
    const guild = (await api.post(owner, '/guilds', { name: 'Typing Guild' })).body;
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(member, `/invites/${invite.body.code}`);
    const general = guild.channels[0];
    const everyone = guild.roles.find((r) => r.is_everyone);
    const [ownerEvents, outsiderEvents] = [owner, outsider].map(listen);

    expect((await typing(member, `channel-${general.id}`)).status).toBe(204);
    expect(typingEvents(ownerEvents)).toEqual([{ type: 'typing', chatId: `channel-${general.id}`, userId: member.id }]);
    expect((await typing(outsider, `channel-${general.id}`)).status).toBe(404);
    expect(typingEvents(outsiderEvents)).toEqual([]);

    // Without Send Messages, no typing either.
    const quiet = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'announcements' })).body;
    await api.put(owner, `/guilds/${guild.id}/channels/${quiet.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.SEND_MESSAGES });
    expect((await typing(member, `channel-${quiet.id}`)).status).toBe(404);

    // A document's replies.
    const docs = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Handbook', type: 'doc' })).body;
    const doc = (await api.post(owner, `/channels/${docs.id}/documents`, { title: 'Rules', content: 'Be nice' })).body;
    ownerEvents.length = 0;
    expect((await typing(member, `document-${doc.id}`)).status).toBe(204);
    expect(typingEvents(ownerEvents)).toEqual([{ type: 'typing', chatId: `document-${doc.id}`, userId: member.id }]);
    expect((await typing(outsider, `document-${doc.id}`)).status).toBe(404);
    // The document channel itself isn't a chat.
    expect((await typing(member, `channel-${docs.id}`)).status).toBe(404);
  });
});
