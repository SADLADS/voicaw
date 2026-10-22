import './helpers/mockS3.js';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import WebSocket from 'ws';
import opaque from '@serenity-kit/opaque';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');
const { attachWebSocketServer } = require('../sockets.js');
const auth = (token) => ({ Authorization: `Bearer ${token}` });

let count = 0;
const name = () => `signup-${++count}`;
const PASSWORD = 'password1234';

let admin;
let member;
beforeAll(async () => {
  admin = (await registerUser(app, request, 'signup-admin', PASSWORD)).response.body;
  member = (await registerUser(app, request, 'signup-member', PASSWORD)).response.body;
  await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [admin.id]);
});

const setMode = (value) => request(app).put('/api/admin/settings/signupMode').set(auth(admin.token)).send({ value });
const setReason = (value) => request(app).put('/api/admin/settings/signupReason').set(auth(admin.token)).send({ value });
afterEach(async () => {
  await setMode(null);
  await setReason(null);
  delete process.env.SIGNUP_MODE;
});

async function makeInvite(body = {}) {
  const res = await request(app).post('/api/admin/invites').set(auth(admin.token)).send(body);
  expect(res.status).toBe(201);
  return res.body.invite.code;
}

describe('the sign-up setting', () => {
  it('is open by default, and only takes its choices', async () => {
    expect((await request(app).get('/api/config')).body.signupMode).toBe('open');
    expect((await setMode('closed')).status).toBe(400);
    const res = await setMode('request');
    expect(res.status).toBe(200);
    expect(res.body.settings.find((s) => s.key === 'signupMode')).toMatchObject({ value: 'request', choices: ['open', 'invite', 'request'], source: 'admin' });
    expect((await request(app).get('/api/config')).body.signupMode).toBe('request');
  });

  it('falls back to SIGNUP_MODE, and ignores a value that is not a choice', async () => {
    process.env.SIGNUP_MODE = 'invite';
    expect((await request(app).get('/api/config')).body.signupMode).toBe('invite');
    process.env.SIGNUP_MODE = 'nonsense';
    expect((await request(app).get('/api/config')).body.signupMode).toBe('open');
  });
});

describe('invite-only sign-ups', () => {
  it('refuses sign-ups without a working invite, before any keys are made', async () => {
    await setMode('invite');
    const { response, failedAt } = await registerUser(app, request, name(), PASSWORD);
    expect(failedAt).toBe('initiate');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('invite_required');

    const bad = await registerUser(app, request, name(), PASSWORD, { invite: 'nope' });
    expect(bad.response.body.code).toBe('invalid_invite');
  });

  it('lets an invite in, as many times as it allows', async () => {
    await setMode('invite');
    const code = await makeInvite({ maxUses: 1 });
    const { response } = await registerUser(app, request, name(), PASSWORD, { invite: code });
    expect(response.status).toBe(201);
    expect(response.body.pending).toBe(false);

    const again = await registerUser(app, request, name(), PASSWORD, { invite: code });
    expect(again.response.status).toBe(403);
    // Used up: no longer listed.
    const { body } = await request(app).get('/api/admin').set(auth(admin.token));
    expect(body.invites.some((i) => i.code === code)).toBe(false);
  });

  it('still lets people change their password (the same OPAQUE route)', async () => {
    await setMode('invite');
    await opaque.ready;
    const { registrationRequest } = opaque.client.startRegistration({ password: 'another-password' });
    const res = await request(app).post('/api/initiateregister').send({ userIdentifier: 'signup-member', registrationRequest });
    expect(res.status).toBe(201);
  });

  it('expires invites, and admins can revoke them', async () => {
    const expiring = await makeInvite({ maxAge: 60 });
    await db.run('UPDATE app_invites SET expires_at = 1 WHERE code = ?', [expiring]);
    const revoked = await makeInvite();
    const res = await request(app).delete(`/api/admin/invites/${revoked}`).set(auth(admin.token));
    expect(res.body.invites.some((i) => i.code === revoked || i.code === expiring)).toBe(false);

    await setMode('invite');
    for (const code of [expiring, revoked]) {
      expect((await registerUser(app, request, name(), PASSWORD, { invite: code })).response.status).toBe(403);
    }
  });

  it('only lets admins manage invites', async () => {
    expect((await request(app).post('/api/admin/invites').set(auth(member.token)).send({})).status).toBe(403);
    expect((await request(app).post('/api/admin/invites').set(auth(admin.token)).send({ maxUses: -1 })).status).toBe(400);
    expect((await request(app).post('/api/admin/invites').set(auth(admin.token)).send({ maxAge: 99999999 })).status).toBe(400);
  });

  it('ignores invites while sign-ups are open', async () => {
    const { response } = await registerUser(app, request, name(), PASSWORD, { invite: 'whatever' });
    expect(response.status).toBe(201);
    expect(response.body.pending).toBe(false);
  });
});

describe('sign-ups that need approval', () => {
  async function requestAccount() {
    await setMode('request');
    const username = name();
    const { response } = await registerUser(app, request, username, PASSWORD);
    expect(response.status).toBe(201);
    expect(response.body.pending).toBe(true);
    return { ...response.body, username };
  }

  it('can log in, but use nothing but its own account', async () => {
    const waiting = await requestAccount();
    const login = await loginUser(app, request, waiting.username, PASSWORD);
    expect(login.response.body.pending).toBe(true);
    const token = login.response.body.token;

    expect((await request(app).get('/api/profile').set(auth(token))).body).toMatchObject({ id: waiting.id, pending: true });
    expect((await request(app).get('/api/sessions').set(auth(token))).status).toBe(200);
    expect((await request(app).get('/api/account/owned-guilds').set(auth(token))).status).toBe(200);
    for (const [method, path] of [['get', '/api/dms-list'], ['get', '/api/guilds'], ['get', '/api/preferences'], ['post', '/api/guilds'], ['put', '/api/profile']]) {
      const res = await request(app)[method](path).set(auth(token)).send({ name: 'x' });
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('pending');
    }
  });

  it("isn't listed or reachable by anyone else", async () => {
    const waiting = await requestAccount();
    const list = await request(app).get('/api/dms-list').set(auth(member.token));
    expect(list.body.some((u) => u.id === waiting.id)).toBe(false);
    const dm = await request(app).post('/api/dm-send').set(auth(member.token)).send({ recipient_id: waiting.id, content: 'v1.x' });
    expect(dm.status).toBe(404);
    expect((await request(app).post('/api/admin/admins').set(auth(admin.token)).send({ username: waiting.username })).status).toBe(400);
  });

  it('skips the wait with an invite', async () => {
    await setMode('request');
    const code = await makeInvite();
    const { response } = await registerUser(app, request, name(), PASSWORD, { invite: code });
    expect(response.body.pending).toBe(false);
  });

  it('is listed for admins, who approve it', async () => {
    const waiting = await requestAccount();
    const { body } = await request(app).get('/api/admin').set(auth(admin.token));
    expect(body.requests.find((r) => r.id === waiting.id)).toMatchObject({ username: waiting.username });
    expect((await request(app).post(`/api/admin/requests/${waiting.id}/approve`).set(auth(member.token))).status).toBe(403);

    const res = await request(app).post(`/api/admin/requests/${waiting.id}/approve`).set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.requests.some((r) => r.id === waiting.id)).toBe(false);
    expect((await request(app).get('/api/dms-list').set(auth(waiting.token))).status).toBe(200);
    expect((await request(app).post(`/api/admin/requests/${waiting.id}/approve`).set(auth(admin.token))).status).toBe(404);
  });

  it('is removed altogether when declined, freeing the name', async () => {
    const waiting = await requestAccount();
    const res = await request(app).delete(`/api/admin/requests/${waiting.id}`).set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(await db.get('SELECT id FROM users WHERE id = ?', [waiting.id])).toBeUndefined();
    expect((await request(app).get('/api/profile').set(auth(waiting.token))).status).toBe(403);
    // Only pending accounts can be declined.
    expect((await request(app).delete(`/api/admin/requests/${member.id}`).set(auth(admin.token))).status).toBe(404);

    await setMode('open');
    expect((await registerUser(app, request, waiting.username, PASSWORD)).response.status).toBe(201);
  });
});

describe('why they want to join', () => {
  it('is optional by default, kept with the request and shown to admins', async () => {
    await setMode('request');
    expect((await request(app).get('/api/config')).body).toMatchObject({ signupMode: 'request', signupReason: 'optional' });
    const quiet = (await registerUser(app, request, name(), PASSWORD)).response;
    expect(quiet.status).toBe(201);
    const chatty = (await registerUser(app, request, name(), PASSWORD, { reason: '  My friends are here  ' })).response;
    expect(chatty.status).toBe(201);
    const { body } = await request(app).get('/api/admin').set(auth(admin.token));
    expect(body.requests.find((r) => r.id === chatty.body.id).reason).toBe('My friends are here');
    expect(body.requests.find((r) => r.id === quiet.body.id).reason).toBeNull();
  });

  it('can be required, refused without one before any keys are made', async () => {
    await setMode('request');
    expect((await setReason('sometimes')).status).toBe(400);
    expect((await setReason('required')).status).toBe(200);
    expect((await request(app).get('/api/config')).body.signupReason).toBe('required');
    const refused = await registerUser(app, request, name(), PASSWORD, { reason: '   ' });
    expect(refused.failedAt).toBe('initiate');
    expect(refused.response.status).toBe(400);
    expect(refused.response.body.code).toBe('reason_required');
    expect((await registerUser(app, request, name(), PASSWORD, { reason: 'x'.repeat(1001) })).response.body.code).toBe('reason_too_long');
    expect((await registerUser(app, request, name(), PASSWORD, { reason: 'Hello' })).response.status).toBe(201);
    // An invite skips the wait, and so the question.
    const { response } = await registerUser(app, request, name(), PASSWORD, { invite: await makeInvite() });
    expect(response.body.pending).toBe(false);
  });

  it("isn't asked or kept while sign-ups are open", async () => {
    await setReason('required');
    const { response } = await registerUser(app, request, name(), PASSWORD, { reason: 'Ignored' });
    expect(response.status).toBe(201);
    expect(await db.get('SELECT id FROM signup_requests WHERE user_id = ?', [response.body.id])).toBeUndefined();
  });
});

describe('the history of requests', () => {
  const history = (token = admin.token, query = '') => request(app).get(`/api/admin/requests/history${query}`).set(auth(token));

  it('keeps approved and declined requests, with who decided, newest first', async () => {
    await setMode('request');
    const yes = (await registerUser(app, request, name(), PASSWORD, { reason: 'Approve me' })).response.body;
    const no = (await registerUser(app, request, name(), PASSWORD, { reason: 'Decline me' })).response.body;
    await request(app).post(`/api/admin/requests/${yes.id}/approve`).set(auth(admin.token));
    await request(app).delete(`/api/admin/requests/${no.id}`).set(auth(admin.token));

    expect((await history(member.token)).status).toBe(403);
    const { body } = await history();
    const declined = body.history.find((r) => r.username === no.username);
    const approved = body.history.find((r) => r.username === yes.username);
    expect(declined).toMatchObject({ status: 'declined', reason: 'Decline me', user_id: null, decided_by: admin.id, decided_by_username: 'signup-admin' });
    expect(approved).toMatchObject({ status: 'approved', reason: 'Approve me', user_id: yes.id, decided_by: admin.id });
    expect(body.history.indexOf(declined)).toBeLessThanOrEqual(body.history.indexOf(approved));
    expect(body.history.some((r) => r.status === 'waiting')).toBe(false);
  });

  it('pages, and forgets an entry an admin deletes', async () => {
    await setMode('request');
    for (let i = 0; i < 3; i++) {
      const waiting = (await registerUser(app, request, name(), PASSWORD)).response.body;
      await request(app).post(`/api/admin/requests/${waiting.id}/approve`).set(auth(admin.token));
    }
    const all = (await history()).body.history;
    const first = all[0];
    const rest = (await history(admin.token, `?before=${first.decided_at}:${first.id}`)).body.history;
    expect(rest.map((r) => r.id)).toEqual(all.slice(1).map((r) => r.id));
    expect((await history(admin.token, '?before=nope')).status).toBe(400);

    expect((await request(app).delete(`/api/admin/requests/history/${first.id}`).set(auth(member.token))).status).toBe(403);
    expect((await request(app).delete(`/api/admin/requests/history/${first.id}`).set(auth(admin.token))).status).toBe(200);
    expect((await history()).body.history.some((r) => r.id === first.id)).toBe(false);
    expect((await request(app).delete(`/api/admin/requests/history/${first.id}`).set(auth(admin.token))).status).toBe(404);
  });

  it('forgets decisions after a year', async () => {
    await setMode('request');
    const waiting = (await registerUser(app, request, name(), PASSWORD)).response.body;
    await request(app).post(`/api/admin/requests/${waiting.id}/approve`).set(auth(admin.token));
    const yearAgo = Math.floor(Date.now() / 1000) - 366 * 24 * 60 * 60;
    await db.run('UPDATE signup_requests SET decided_at = ? WHERE user_id = ?', [yearAgo, waiting.id]);
    expect((await history()).body.history.some((r) => r.user_id === waiting.id)).toBe(false);
    expect(await db.get('SELECT id FROM signup_requests WHERE user_id = ?', [waiting.id])).toBeUndefined();
  });
});

describe('withdrawing a request', () => {
  it('deletes the account altogether', async () => {
    await setMode('request');
    const username = name();
    const waiting = (await registerUser(app, request, username, PASSWORD)).response.body;
    await opaque.ready;
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: PASSWORD });
    const started = await request(app).post('/api/initiatelogin').send({ userIdentifier: username, startLoginRequest });
    const result = opaque.client.finishLogin({ clientLoginState, loginResponse: started.body.loginResponse, password: PASSWORD });
    const res = await request(app).delete('/api/account').set(auth(waiting.token))
      .send({ finishLoginRequest: result.finishLoginRequest, clientSessionKey: result.sessionKey, groupLeaves: {} });
    expect(res.status).toBe(200);
    expect(await db.get('SELECT id FROM users WHERE id = ?', [waiting.id])).toBeUndefined();
    // Not even in the history.
    expect(await db.get('SELECT id FROM signup_requests WHERE username = ?', [username])).toBeUndefined();
  });
});

describe('websockets of accounts waiting for approval', () => {
  const server = http.createServer(app);
  const wss = attachWebSocketServer(server);
  let url;
  beforeAll(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => {
    wss.close();
    server.close();
  });

  async function connect(token) {
    const ws = new WebSocket(url);
    const received = [];
    ws.on('message', (m) => received.push(JSON.parse(m)));
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'identify', token }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { ws, received };
  }

  it('get nothing until approved, then carry on as logged in', async () => {
    await setMode('request');
    const waiting = (await registerUser(app, request, name(), PASSWORD)).response.body;
    const socket = await connect(waiting.token);
    expect(socket.received).toEqual([]);
    expect(app.locals.clients.has(String(waiting.id))).toBe(false);

    await request(app).post(`/api/admin/requests/${waiting.id}/approve`).set(auth(admin.token));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.received[0].type).toBe('account_approved');
    expect(socket.received.some((e) => e.type === 'presence_snapshot')).toBe(true);
    expect(app.locals.clients.has(String(waiting.id))).toBe(true);
    socket.ws.close();
  });

  it('are told and closed when declined', async () => {
    await setMode('request');
    const waiting = (await registerUser(app, request, name(), PASSWORD)).response.body;
    const socket = await connect(waiting.token);
    const closed = new Promise((resolve) => socket.ws.on('close', (code) => resolve(code)));
    await request(app).delete(`/api/admin/requests/${waiting.id}`).set(auth(admin.token));
    expect(await closed).toBe(1008);
    expect(socket.received.map((e) => e.type)).toEqual(['account_deleted']);
  });
});
