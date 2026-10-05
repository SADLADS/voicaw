import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import opaque from '@serenity-kit/opaque';
import { randomUUID } from 'crypto';
import { registerUser, loginUser } from './helpers/authFlow.js';
import { sealName } from './helpers/groupNames.js';
import { importIdentityPrivateKey, importEncryptionPrivateKey } from '../../client/src/services/encryptionService.js';
import {
  makeRecord, signRecord, entryHash, generateGroupKey, wrapGroupKey, groupKeyContext,
} from '../../client/src/services/groupCrypto.js';

const app = require('../index.js');
const clients = app.locals.clients;

const PASSWORD = 'pw-account-123';
let userCount = 0;
async function makeUser(prefix = 'acct') {
  const username = `${prefix}-${++userCount}`;
  const { response: regRes, keys } = await registerUser(app, request, username, PASSWORD);
  const { response: loginRes } = await loginUser(app, request, username, PASSWORD);
  return {
    id: regRes.body.id, username, token: loginRes.body.token, keys,
    signingKey: await importIdentityPrivateKey(keys.private.identityKey),
    encryptionKey: await importEncryptionPrivateKey(keys.private.encryptionKey),
  };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url, body = {}) => request(app).delete(`/api${url}`).set(authed(user)).send(body),
};

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), close: () => { ws.closed = true; } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return { events, ws };
}

// A login proof for the password, as the app makes it (a fresh OPAQUE login, not finished).
async function proof(user, password = PASSWORD) {
  await opaque.ready;
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
  const started = await request(app).post('/api/initiatelogin').send({ userIdentifier: user.username, startLoginRequest });
  const result = opaque.client.finishLogin({ clientLoginState, loginResponse: started.body.loginResponse, password });
  // A wrong password fails on the device; send something so the server says so too.
  return result
    ? { finishLoginRequest: result.finishLoginRequest, clientSessionKey: result.sessionKey }
    : { finishLoginRequest: 'x', clientSessionKey: 'x' };
}

async function signed(actor, fields) {
  const record = makeRecord({ actor: actor.id, ...fields });
  return { record, signature: await signRecord(record, actor.signingKey) };
}

async function epochFor(creator, groupId, logSeq, members) {
  const key = generateGroupKey();
  const envelopes = {};
  for (const m of members) {
    envelopes[m.id] = await wrapGroupKey(key, creator.encryptionKey, m.keys.public.encryptionKey, groupKeyContext(groupId, 1, logSeq, creator.id, m.id));
  }
  return { epoch: 1, logSeq, envelopes, name: await sealName(creator, groupId, 1, { keyBytes: key }), nameVersion: 1 };
}

// A group made by `owner` with `others` (at least two).
async function createGroup(owner, others) {
  const groupId = randomUUID();
  const log = [];
  let prev = null;
  for (const [seq, target] of [null, ...others].entries()) {
    const e = await signed(owner, {
      groupId, seq, prev, type: seq === 0 ? 'create' : 'add', target: target?.id ?? null,
      targetIdentityKey: (target ?? owner).keys.public.identityKey,
    });
    log.push(e);
    prev = await entryHash(e.record, e.signature);
  }
  const res = await api.post(owner, '/group-dms', { id: groupId, log, epoch: await epochFor(owner, groupId, log.length - 1, [owner, ...others]) });
  expect(res.status).toBe(201);
  return groupId;
}

// `user`'s signed leave entry for the group as it is now.
async function leaveEntry(user, groupId) {
  const group = (await api.get(user, `/group-dms/${groupId}`)).body;
  const last = group.log.at(-1);
  return signed(user, { groupId, seq: last.seq + 1, prev: await entryHash(last.record, last.signature), type: 'leave', target: user.id });
}

async function createGuild(owner, name = 'Mine') {
  const res = await api.post(owner, '/guilds', { name });
  expect(res.status).toBe(201);
  return res.body;
}

async function join(user, guild, inviter) {
  const invite = await api.post(inviter, `/guilds/${guild.id}/invites`);
  expect((await api.post(user, `/invites/${invite.body.code}`)).status).toBe(201);
}

describe('deleting your account', () => {
  it('needs the password, and keeps the account when it is wrong', async () => {
    const ann = await makeUser();
    const res = await api.delete(ann, '/account', await proof(ann, 'not-the-password'));
    expect(res.status).toBe(401);
    expect((await api.get(ann, '/profile')).status).toBe(200);
  });

  it('asks for owned guilds to be handed over or deleted, and deletes them when asked', async () => {
    const ann = await makeUser();
    const bob = await makeUser();
    const guild = await createGuild(ann);
    await join(bob, guild, ann);

    expect((await api.get(ann, '/account/owned-guilds')).body).toEqual([{ id: guild.id, name: 'Mine' }]);
    const refused = await api.delete(ann, '/account', await proof(ann));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'owns_guilds', guilds: [{ id: guild.id, name: 'Mine' }] });
    // Refused before the proof was used: the account is still there.
    expect((await api.get(ann, '/profile')).status).toBe(200);

    const { events } = listen(bob);
    const res = await api.delete(ann, '/account', { ...(await proof(ann)), deleteOwnedGuilds: true });
    expect(res.status).toBe(200);
    expect((await api.get(bob, `/guilds/${guild.id}`)).status).toBe(404);
    expect(events).toContainEqual({ type: 'guild_remove', guildId: guild.id });
  });

  it('lets someone who handed their guild over delete their account; they leave it', async () => {
    const ann = await makeUser();
    const bob = await makeUser();
    const guild = await createGuild(ann);
    await join(bob, guild, ann);
    expect((await api.post(ann, `/guilds/${guild.id}/transfer`, { userId: bob.id })).status).toBe(200);

    const { events } = listen(bob);
    expect((await api.delete(ann, '/account', await proof(ann))).status).toBe(200);
    const members = (await api.get(bob, `/guilds/${guild.id}/members`)).body;
    expect(members.map((m) => m.id)).toEqual([bob.id]);
    expect(events).toContainEqual({ type: 'guild_member_remove', guildId: guild.id, userId: ann.id });
  });

  it('leaves group DMs with entries signed on the device, all checked first', async () => {
    const ann = await makeUser();
    const bob = await makeUser();
    const cal = await makeUser();
    const shared = await createGroup(bob, [ann, cal]);
    const alone = await createGroup(ann, [bob, cal]);
    for (const user of [bob, cal]) {
      expect((await api.post(user, `/group-dms/${alone}/log`, { entry: await leaveEntry(user, alone) })).status).toBe(200);
    }

    // Missing one: refused, nothing changed.
    const partial = await api.delete(ann, '/account', { ...(await proof(ann)), groupLeaves: { [shared]: await leaveEntry(ann, shared) } });
    expect(partial.status).toBe(409);
    expect(partial.body.code).toBe('groups_changed');

    const { events } = listen(bob);
    const groupLeaves = { [shared]: await leaveEntry(ann, shared), [alone]: await leaveEntry(ann, alone) };
    expect((await api.delete(ann, '/account', { ...(await proof(ann)), groupLeaves })).status).toBe(200);

    const group = (await api.get(bob, `/group-dms/${shared}`)).body;
    expect(JSON.parse(group.log.at(-1).record)).toMatchObject({ type: 'leave', actor: ann.id });
    expect(events.some((e) => e.type === 'group_dm_update' && e.group.id === shared)).toBe(true);
    // The group only Ann was in is gone.
    expect((await api.get(bob, `/group-dms/${alone}`)).status).toBe(404);
  });

  it('turns the account into "Deleted User": logged out everywhere, name free, DMs kept but closed', async () => {
    const ann = await makeUser();
    const bob = await makeUser();
    const content = 'v1.' + 'A'.repeat(40);
    expect((await api.post(bob, '/dm-send', { recipient_id: ann.id, content })).status).toBe(201);
    expect((await api.post(ann, '/dm-send', { recipient_id: ann.id, content })).status).toBe(201); // notes
    const annSocket = listen(ann);
    const bobSocket = listen(bob);

    expect((await api.delete(ann, '/account', await proof(ann))).status).toBe(200);

    // Logged out: the token no longer works, and the open socket is told and closed.
    expect((await api.get(ann, '/profile')).status).toBe(403);
    expect(annSocket.events).toContainEqual({ type: 'account_deleted' });
    expect(annSocket.ws.closed).toBe(true);
    expect((await require('../db').get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [ann.id])).n).toBe(0);
    // Can't log in; the name can be taken again.
    expect((await loginUser(app, request, ann.username, PASSWORD)).failedAt).toBe('finishLogin-client');
    const { response } = await registerUser(app, request, ann.username, PASSWORD);
    expect(response.status).toBe(201);

    // Everyone sees the new name; the conversation stays (with the public keys), but can't be answered.
    const profile = bobSocket.events.find((e) => e.type === 'user_profile' && e.user.id === ann.id).user;
    expect(profile).toMatchObject({ display_name: 'Deleted User', avatar: null, bio: null });
    expect(profile.deleted_at).toBeTruthy();
    const listed = (await api.get(bob, '/dms-list')).body.find((u) => u.id === ann.id);
    expect(listed).toMatchObject({ display_name: 'Deleted User', identity_key: ann.keys.public.identityKey });
    expect(listed.deleted_at).toBeTruthy();
    expect((await api.get(bob, `/dm-messages/${ann.id}`)).body).toHaveLength(1);
    expect((await api.post(bob, '/dm-send', { recipient_id: ann.id, content })).status).toBe(404);

    // Someone you never talked to doesn't show up at all.
    const cal = await makeUser();
    expect((await api.get(cal, '/dms-list')).body.some((u) => u.id === ann.id)).toBe(false);
  });

  it('deletes their bot applications too, taking the bots out of guilds', async () => {
    const db = require('../db');
    const ann = await makeUser();
    const bob = await makeUser();
    const app1 = (await api.post(ann, '/applications', { name: 'Ann Bot' })).body;
    const guild = await createGuild(bob, 'Bob place');
    await db.run('INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', [guild.id, app1.id, Math.floor(Date.now() / 1000)]);
    const bobsBot = (await api.post(bob, '/applications', { name: 'Bob Bot' })).body;

    expect((await api.delete(ann, '/account', await proof(ann))).status).toBe(200);

    expect(await db.get('SELECT 1 FROM bot_applications WHERE id = ?', [app1.id])).toBeUndefined();
    expect(await db.get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', [guild.id, app1.id])).toBeUndefined();
    expect((await db.get('SELECT deleted_at FROM users WHERE id = ?', [app1.id])).deleted_at).toBeTruthy();
    // Someone else's bot is left alone.
    expect(await db.get('SELECT 1 FROM bot_applications WHERE id = ?', [bobsBot.id])).toBeTruthy();
  });

  it("can't put a deleted account into a group", async () => {
    const ann = await makeUser();
    const bob = await makeUser();
    expect((await api.delete(ann, '/account', await proof(ann))).status).toBe(200);
    const cal = await makeUser();
    const groupId = await createGroup(bob, [cal, (await makeUser())]);
    const group = (await api.get(bob, `/group-dms/${groupId}`)).body;
    const last = group.log.at(-1);
    const add = await signed(bob, {
      groupId, seq: last.seq + 1, prev: await entryHash(last.record, last.signature), type: 'add', target: ann.id,
      targetIdentityKey: ann.keys.public.identityKey,
    });
    expect((await api.post(bob, `/group-dms/${groupId}/log`, { entry: add })).status).toBe(404);
  });
});
