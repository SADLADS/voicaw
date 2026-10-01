import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { registerUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { SESSION_SECONDS, RENEW_AFTER_SECONDS } = require('../auth');

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
