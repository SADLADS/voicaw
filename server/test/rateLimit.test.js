import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

// On for this file only (see setupEnv.js). Each test uses its own addresses, since the
// limiters live for the whole file.
process.env.DISABLE_RATE_LIMITS = '';
const app = require('../index.js');

// As nginx sends it: the client's address last in X-Forwarded-For.
const from = (ip) => ({ 'X-Forwarded-For': ip });

function startLogin(username, ip) {
  return request(app).post('/api/initiatelogin').set(from(ip)).send({ userIdentifier: username, startLoginRequest: 'x' });
}

describe('rate limits', () => {
  it('limits login attempts per username, from any address, whether or not it exists', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await startLogin('nobody-here', `10.0.1.${i}`);
      expect(res.status).not.toBe(429);
    }
    const blocked = await startLogin('nobody-here', '10.0.1.200');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/^Too many attempts\. Try again in 1[45] minutes\.$/);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(800);

    // Other usernames aren't affected.
    expect((await startLogin('someone-else', '10.0.1.201')).status).not.toBe(429);
  });

  it('limits login attempts per address', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await startLogin(`user-${i}`, '10.0.2.1')).status).not.toBe(429);
    }
    expect((await startLogin('user-new', '10.0.2.1')).status).toBe(429);
    expect((await startLogin('user-new', '10.0.2.2')).status).not.toBe(429);
  });

  it('clears the username count on a successful login', async () => {
    await registerUser(app, request, 'limited-alice', 'correct horse battery');
    for (let i = 0; i < 19; i++) await startLogin('limited-alice', `10.0.3.${i}`);

    const { response } = await loginUser(app, request, 'limited-alice', 'correct horse battery');
    expect(response.status).toBe(200);
    expect((await startLogin('limited-alice', '10.0.3.100')).status).not.toBe(429);
  });

  it('limits registrations per address', async () => {
    const finish = () => request(app).post('/api/finaliseregister').set(from('10.0.4.1')).send({});
    for (let i = 0; i < 10; i++) expect((await finish()).status).toBe(400);
    expect((await finish()).status).toBe(429);
  });

  it('rejects usernames that are not text', async () => {
    const res = await request(app).post('/api/initiatelogin').set(from('10.0.5.1')).send({ userIdentifier: { a: 1 }, startLoginRequest: 'x' });
    expect(res.status).toBe(400);
  });

  it("limits each webhook to Discord's 5 requests per 2 seconds, with Discord's headers", async () => {
    const { response: reg } = await registerUser(app, request, 'hook-owner', 'pw-hook-owner-1');
    const { response: login } = await loginUser(app, request, 'hook-owner', 'pw-hook-owner-1');
    const auth = { Authorization: `Bearer ${login.body.token}` };
    expect(reg.status).toBe(201);
    const guild = (await request(app).post('/api/guilds').set(auth).send({ name: 'Limits' })).body;
    const hook = (await request(app).post(`/api/channels/${guild.channels[0].id}/webhooks`).set(auth).send({ name: 'Fast' })).body;
    const post = () => request(app).post(`/api/webhooks/${hook.id}/${hook.token}`).send({ content: 'hi' });
    for (let i = 0; i < 5; i++) {
      const res = await post();
      expect(res.status).toBe(204);
      expect(res.headers['x-ratelimit-remaining']).toBe(String(4 - i));
    }
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ message: 'You are being rate limited.', global: false, retry_after: expect.any(Number) });
    expect(limited.body.retry_after).toBeLessThanOrEqual(2);
  });
});
