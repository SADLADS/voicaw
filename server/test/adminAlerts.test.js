import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');
const clients = app.locals.clients;

const PASSWORD = 'pw-alerts-123';
let count = 0;
async function makeUser({ admin = false } = {}) {
  const username = `alerts-${++count}`;
  const { response } = await registerUser(app, request, username, PASSWORD);
  if (admin) await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [response.body.id]);
  const login = await loginUser(app, request, username, PASSWORD);
  const user = { id: response.body.id, token: login.response.body.token, endpoint: `https://push.test/${username}`, events: [] };
  await request(app).post('/api/save-subscription').set(authed(user))
    .send({ subscription: { endpoint: user.endpoint, keys: { p256dh: 'p', auth: 'a' } } });
  clients.set(String(user.id), [{ readyState: 1, send: (m) => user.events.push(JSON.parse(m)) }]);
  return user;
}
const authed = (u) => ({ Authorization: `Bearer ${u.token}` });
const lastAlerts = (u) => u.events.filter((e) => e.type === 'admin_alerts').at(-1);
const adminPushesTo = (u, since) => sentPushes.slice(since).filter((p) => p.endpoint === u.endpoint && p.payload.type === 'admin');

let mod;
let mod2;
let ann;
let bob;
beforeAll(async () => {
  mod = await makeUser({ admin: true });
  mod2 = await makeUser({ admin: true });
  ann = await makeUser();
  bob = await makeUser();
});
afterAll(() => {
  for (const u of [mod, mod2, ann, bob]) clients.delete(String(u.id));
});

describe('admin alerts', () => {
  it('counts what is waiting, for admins only', async () => {
    const res = await request(app).get('/api/admin/alerts').set(authed(mod));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reports: 0, signups: 0, testers: 0 });
    expect((await request(app).get('/api/admin/alerts').set(authed(ann))).status).toBe(403);
    expect((await request(app).get('/api/admin/alerts')).status).toBe(401);
  });

  it('tells admins about a new report until it is resolved', async () => {
    const since = sentPushes.length;
    const res = await request(app).post('/api/reports').set(authed(ann)).send({ kind: 'user', userId: bob.id, category: 'spam' });
    expect(res.status).toBe(201);
    expect(lastAlerts(mod)).toEqual({ type: 'admin_alerts', reports: 1, signups: 0, testers: 0 });
    expect(ann.events.some((e) => e.type === 'admin_alerts')).toBe(false);

    await waitForPushes(2, since);
    const [push] = adminPushesTo(mod, since);
    expect(push.payload).toMatchObject({ kind: 'report', count: 1, url: '/settings/reports#reports', tag: 'admin-report' });
    expect(adminPushesTo(mod2, since)).toHaveLength(1);
    expect(adminPushesTo(ann, since)).toHaveLength(0);
    // Nothing about who or why.
    expect(JSON.stringify(push.payload)).not.toContain('spam');

    await request(app).post(`/api/admin/reports/${res.body.id}/dismiss`).set(authed(mod)).expect(200);
    expect(lastAlerts(mod2)).toMatchObject({ reports: 0 });
  });

  it("doesn't notify the admin who reported", async () => {
    const since = sentPushes.length;
    const res = await request(app).post('/api/reports').set(authed(mod)).send({ kind: 'user', userId: bob.id, category: 'other' });
    await waitForPushes(1, since);
    await new Promise((r) => setTimeout(r, 50));
    expect(adminPushesTo(mod, since)).toHaveLength(0);
    expect(adminPushesTo(mod2, since)).toHaveLength(1);
    await request(app).post(`/api/admin/reports/${res.body.id}/dismiss`).set(authed(mod)).expect(200);
  });

  it('tells admins about new tester requests (not repeated ones), without the email', async () => {
    let since = sentPushes.length;
    await request(app).post('/api/tester-requests').send({ email: 'pal@example.com' }).expect(201);
    expect(lastAlerts(mod)).toMatchObject({ testers: 1 });
    await waitForPushes(2, since);
    const [push] = adminPushesTo(mod, since);
    expect(push.payload).toMatchObject({ kind: 'tester', count: 1, url: '/settings/admin#admin-signups' });
    expect(JSON.stringify(push.payload)).not.toContain('pal@');

    since = sentPushes.length;
    await request(app).post('/api/tester-requests').send({ email: 'pal@example.com', note: 'again' }).expect(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(adminPushesTo(mod, since)).toHaveLength(0);

    const { id } = await db.get("SELECT id FROM tester_requests WHERE email = 'pal@example.com'");
    await request(app).put(`/api/admin/tester-requests/${id}`).set(authed(mod)).send({ added: true }).expect(200);
    expect(lastAlerts(mod)).toMatchObject({ testers: 0 });
  });

  it('tells admins about accounts waiting for approval, with the username', async () => {
    await request(app).put('/api/admin/settings/signupMode').set(authed(mod)).send({ value: 'request' }).expect(200);
    const since = sentPushes.length;
    const { response } = await registerUser(app, request, 'alerts-newcomer', PASSWORD);
    expect(response.body.pending).toBe(true);
    expect(lastAlerts(mod)).toMatchObject({ signups: 1 });
    await waitForPushes(2, since);
    expect(adminPushesTo(mod, since)[0].payload).toMatchObject({ kind: 'signup', count: 1, name: 'alerts-newcomer' });

    await request(app).post(`/api/admin/requests/${response.body.id}/approve`).set(authed(mod)).expect(200);
    expect(lastAlerts(mod)).toMatchObject({ signups: 0 });
    await request(app).put('/api/admin/settings/signupMode').set(authed(mod)).send({ value: null }).expect(200);
  });

  it('clears the count of someone who stops being an admin', async () => {
    await request(app).post('/api/reports').set(authed(ann)).send({ kind: 'user', userId: bob.id, category: 'spam' }).expect(201);
    expect(lastAlerts(mod2)).toMatchObject({ reports: 1 });
    await request(app).delete(`/api/admin/admins/${mod2.id}`).set(authed(mod)).expect(200);
    expect(lastAlerts(mod2)).toEqual({ type: 'admin_alerts', reports: 0, signups: 0, testers: 0 });
    expect(lastAlerts(mod)).toMatchObject({ reports: 1 });
  });
});
