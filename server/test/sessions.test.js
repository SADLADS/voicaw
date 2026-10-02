import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { SESSION_SECONDS, RENEW_AFTER_SECONDS } = require('../auth');
const db = require('../db');

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const now = () => Math.floor(Date.now() / 1000);
// A token for `user` made `age` seconds ago, lasting the usual time from then.
const tokenFrom = (user, age) => jwt.sign(
  { id: user.id, username: user.username, iat: now() - age },
  process.env.JWT_SECRET,
  { expiresIn: SESSION_SECONDS },
);

describe('login sessions', () => {
  it('logins last 30 days', async () => {
    const { token } = (await registerUser(app, request, 'session-length', 'pw')).response.body;
    const { iat, exp } = jwt.decode(token);
    expect(exp - iat).toBe(30 * 24 * 60 * 60);
  });

  it('a fresh token is not renewed', async () => {
    const { token } = (await registerUser(app, request, 'session-fresh', 'pw')).response.body;
    const res = await request(app).get('/api/profile').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.headers['x-voicaw-token']).toBeUndefined();
  });

  it('a token over a day old comes back renewed, and the new one works', async () => {
    const user = (await registerUser(app, request, 'session-renew', 'pw')).response.body;
    const old = tokenFrom(user, RENEW_AFTER_SECONDS + 60);
    const res = await request(app).get('/api/profile').set(auth(old));
    expect(res.status).toBe(200);
    const renewed = res.headers['x-voicaw-token'];
    expect(renewed).toBeTruthy();
    const payload = jwt.decode(renewed);
    expect(payload.id).toBe(user.id);
    expect(payload.exp).toBeGreaterThan(jwt.decode(old).exp);
    expect((await request(app).get('/api/profile').set(auth(renewed))).status).toBe(200);
  });

  it('an expired token is refused and not renewed', async () => {
    const user = (await registerUser(app, request, 'session-expired', 'pw')).response.body;
    const expired = tokenFrom(user, SESSION_SECONDS + 60);
    const res = await request(app).get('/api/profile').set(auth(expired));
    expect(res.status).toBe(403);
    expect(res.headers['x-voicaw-token']).toBeUndefined();
  });

  it('the page may read the renewed token across origins', async () => {
    const user = (await registerUser(app, request, 'session-cors', 'pw')).response.body;
    const res = await request(app).get('/api/profile')
      .set('Origin', 'https://voicaw.com')
      .set(auth(tokenFrom(user, RENEW_AFTER_SECONDS + 60)));
    expect(res.headers['access-control-expose-headers']).toMatch(/X-Voicaw-Token/i);
  });
});

describe('devices (login sessions)', () => {
  // A user logged in on two devices: the registration and a login.
  async function twoDevices(name) {
    const first = (await registerUser(app, request, name, 'pw')).response.body;
    const second = (await loginUser(app, request, name, 'pw')).response.body;
    return { user: first, a: first.token, b: second.token };
  }
  const list = async (token) => (await request(app).get('/api/sessions').set(auth(token))).body;
  const works = async (token) => (await request(app).get('/api/profile').set(auth(token))).status === 200;

  it('every login is a session, and the list says which one is this device', async () => {
    const { a, b } = await twoDevices('devices-list');
    const sessions = await list(a);
    expect(sessions).toHaveLength(2);
    const current = sessions[0];
    expect(current.current).toBe(true);
    expect(current.id).toBe(jwt.decode(a).sid);
    expect(sessions.find((s) => !s.current).id).toBe(jwt.decode(b).sid);
    expect(current).toMatchObject({ online: false });
    expect(typeof current.created_at).toBe('number');
    expect(typeof current.last_used_at).toBe('number');
  });

  it('a renewed token stays the same session', async () => {
    const user = (await registerUser(app, request, 'devices-renew', 'pw')).response.body;
    const { sid } = jwt.decode(user.token);
    const old = jwt.sign({ id: user.id, username: user.username, sid, iat: now() - RENEW_AFTER_SECONDS - 60 },
      process.env.JWT_SECRET, { expiresIn: SESSION_SECONDS });
    const renewed = (await request(app).get('/api/profile').set(auth(old))).headers['x-voicaw-token'];
    expect(jwt.decode(renewed).sid).toBe(sid);
    expect(await list(renewed)).toHaveLength(1);
  });

  it('logs out another device, which then cannot use its token', async () => {
    const { a, b } = await twoDevices('devices-one');
    const res = await request(app).delete(`/api/sessions/${jwt.decode(b).sid}`).set(auth(a));
    expect(res.status).toBe(200);
    expect(res.body.map((s) => s.id)).toEqual([jwt.decode(a).sid]);
    expect(await works(b)).toBe(false);
    expect(await works(a)).toBe(true);
  });

  it("tells the logged-out device's open sockets, and closes them", async () => {
    const { user, a, b } = await twoDevices('devices-socket');
    const socket = (token) => {
      const ws = { readyState: 1, sessionId: jwt.decode(token).sid, events: [], send: (m) => ws.events.push(JSON.parse(m)), close: () => { ws.closed = true; } };
      return ws;
    };
    const wsA = socket(a);
    const wsB = socket(b);
    app.locals.clients.set(String(user.id), [wsA, wsB]);
    expect((await list(a)).every((s) => s.online)).toBe(true);
    await request(app).delete(`/api/sessions/${wsB.sessionId}`).set(auth(a));
    app.locals.clients.delete(String(user.id));
    expect(wsB.events).toEqual([{ type: 'session_revoked' }]);
    expect(wsB.closed).toBe(true);
    expect(wsA.events).toEqual([]);
    expect(wsA.closed).toBeUndefined();
  });

  it('logs out every other device', async () => {
    const { a, b } = await twoDevices('devices-all');
    const c = (await loginUser(app, request, 'devices-all', 'pw')).response.body.token;
    const res = await request(app).delete('/api/sessions').set(auth(a));
    expect(res.body).toHaveLength(1);
    expect(res.body[0].current).toBe(true);
    expect(await works(a)).toBe(true);
    expect(await works(b)).toBe(false);
    expect(await works(c)).toBe(false);
  });

  it("can't log out someone else's session", async () => {
    const { a } = await twoDevices('devices-mine');
    const other = (await registerUser(app, request, 'devices-theirs', 'pw')).response.body.token;
    const res = await request(app).delete(`/api/sessions/${jwt.decode(a).sid}`).set(auth(other));
    expect(res.status).toBe(404);
    expect(await works(a)).toBe(true);
  });

  it('logging out ends the session', async () => {
    const { a, b } = await twoDevices('devices-logout');
    expect((await request(app).post('/api/logout').set(auth(a))).status).toBe(200);
    expect(await works(a)).toBe(false);
    expect(await list(b)).toHaveLength(1);
  });

  it("a logged-out device's push subscription goes with it", async () => {
    const { user, a, b } = await twoDevices('devices-push');
    const subscription = (endpoint) => ({ endpoint, keys: { p256dh: 'x', auth: 'y' } });
    await request(app).post('/api/save-subscription').set(auth(a)).send({ subscription: subscription('https://push.test/a') });
    await request(app).post('/api/save-subscription').set(auth(b)).send({ subscription: subscription('https://push.test/b') });
    await request(app).delete(`/api/sessions/${jwt.decode(b).sid}`).set(auth(a));
    const left = await db.all('SELECT endpoint FROM push_subscriptions WHERE user_id = ?', [user.id]);
    expect(left.map((r) => r.endpoint)).toEqual(['https://push.test/a']);
  });

  it('records the device and when it was last used', async () => {
    const { a } = await twoDevices('devices-seen');
    const { sid } = jwt.decode(a);
    await db.run('UPDATE sessions SET last_used_at = last_used_at - 3600 WHERE id = ?', [sid]);
    await request(app).get('/api/profile').set(auth(a)).set('User-Agent', 'TestBrowser/1.0');
    const row = await db.get('SELECT last_used_at, user_agent FROM sessions WHERE id = ?', [sid]);
    expect(row.user_agent).toBe('TestBrowser/1.0');
    expect(row.last_used_at).toBeGreaterThanOrEqual(now() - 5);
  });

  it('logins unused past a token life are cleared at the next login', async () => {
    const { user, b } = await twoDevices('devices-stale');
    await db.run('UPDATE sessions SET last_used_at = ? WHERE id = ?', [now() - SESSION_SECONDS - 60, jwt.decode(b).sid]);
    const c = (await loginUser(app, request, 'devices-stale', 'pw')).response.body.token;
    expect(await list(c)).toHaveLength(2);
    expect((await db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [user.id])).n).toBe(2);
  });
});

describe('tokens from before login sessions', () => {
  const legacy = (user, age = 60) => jwt.sign(
    { id: user.id, username: user.username, iat: now() - age }, process.env.JWT_SECRET, { expiresIn: SESSION_SECONDS },
  );

  it('become a session on first use, and are renewed with it at once', async () => {
    const user = (await registerUser(app, request, 'legacy-convert', 'pw')).response.body;
    const old = legacy(user);
    const res = await request(app).get('/api/profile').set(auth(old)).set('User-Agent', 'OldDevice/1');
    expect(res.status).toBe(200);
    const renewed = res.headers['x-voicaw-token'];
    expect(jwt.decode(renewed).sid).toBeTruthy();
    const sessions = await list(renewed);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.current).user_agent).toBe('OldDevice/1');
  });

  it('requests sent at once share one session', async () => {
    const user = (await registerUser(app, request, 'legacy-parallel', 'pw')).response.body;
    const old = legacy(user);
    await Promise.all([1, 2, 3].map(() => request(app).get('/api/profile').set(auth(old))));
    expect((await db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [user.id])).n).toBe(2);
  });

  it('are refused once a session has been logged out from Settings', async () => {
    const user = (await registerUser(app, request, 'legacy-reset', 'pw')).response.body;
    const used = legacy(user, 120);
    const unused = legacy(user, 60);
    const renewed = (await request(app).get('/api/profile').set(auth(used))).headers['x-voicaw-token'];
    await request(app).delete('/api/sessions').set(auth(user.token));
    expect((await request(app).get('/api/profile').set(auth(unused))).status).toBe(403);
    expect((await request(app).get('/api/profile').set(auth(used))).status).toBe(403);
    expect((await request(app).get('/api/profile').set(auth(renewed))).status).toBe(403);
    expect((await request(app).get('/api/profile').set(auth(user.token))).status).toBe(200);
  });

  async function list(token) {
    return (await request(app).get('/api/sessions').set(auth(token))).body;
  }
});
