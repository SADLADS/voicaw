import './helpers/mockS3.js';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');
const clients = app.locals.clients;

let count = 0;
const PASSWORD = 'pw-report-123';
async function makeUser({ admin = false } = {}) {
  const username = `report-${++count}`;
  const { response } = await registerUser(app, request, username, PASSWORD);
  if (admin) await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [response.body.id]);
  const login = await loginUser(app, request, username, PASSWORD);
  return { id: response.body.id, username, token: login.response.body.token };
}
const authed = (u) => ({ Authorization: `Bearer ${u.token}` });
const api = {
  get: (u, url) => request(app).get(`/api${url}`).set(authed(u)),
  post: (u, url, body = {}) => request(app).post(`/api${url}`).set(authed(u)).send(body),
  delete: (u, url) => request(app).delete(`/api${url}`).set(authed(u)),
};
function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), close() { ws.closed = true; } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return { events, ws };
}

let mod;
let ann;
let bob;
let guild;
let channel;
beforeEach(async () => {
  mod = await makeUser({ admin: true });
  ann = await makeUser();
  bob = await makeUser();
  guild = (await api.post(ann, '/guilds', { name: 'Place' })).body;
  channel = guild.channels[0];
  const invite = (await api.post(ann, `/guilds/${guild.id}/invites`)).body;
  await api.post(bob, `/invites/${invite.code}`);
});

describe('reports', () => {
  it('keeps a reported guild message as it was, even once deleted, and tells admins', async () => {
    const adminSocket = listen(mod);
    const msg = (await api.post(bob, `/channels/${channel.id}/messages`, { content: 'buy cheap pills' })).body;
    const res = await api.post(ann, '/reports', { kind: 'message', place: 'guild', messageId: msg.id, category: 'spam', note: 'every day' });
    expect(res.status).toBe(201);
    expect(adminSocket.events).toContainEqual({ type: 'reports_changed', open: expect.any(Number) });
    await api.delete(bob, `/guild-messages/${msg.id}`);
    const { open } = (await api.get(mod, '/admin/reports')).body;
    expect(open.find((r) => r.id === res.body.id)).toMatchObject({
      reporter_id: ann.id, reported_id: bob.id, category: 'spam', note: 'every day', place: 'guild',
      content: 'buy cheap pills', shared: 0, guild_name: 'Place',
    });
  });

  it("only takes what the reporter can see, and an encrypted message's text only if they share it", async () => {
    const outsider = await makeUser();
    const msg = (await api.post(bob, `/channels/${channel.id}/messages`, { content: 'hi' })).body;
    expect((await api.post(outsider, '/reports', { kind: 'message', place: 'guild', messageId: msg.id, category: 'spam' })).status).toBe(404);
    expect((await api.post(bob, '/reports', { kind: 'message', place: 'guild', messageId: msg.id, category: 'spam' })).status).toBe(400);
    expect((await api.post(ann, '/reports', { kind: 'message', place: 'guild', messageId: msg.id, category: 'nonsense' })).status).toBe(400);

    const dm = (await api.post(bob, '/dm-send', { recipient_id: ann.id, content: `v1.${'A'.repeat(40)}` })).body;
    expect((await api.post(outsider, '/reports', { kind: 'message', place: 'dm', messageId: dm.id, category: 'harassment' })).status).toBe(404);
    const quiet = (await api.post(ann, '/reports', { kind: 'message', place: 'dm', messageId: dm.id, category: 'harassment' })).body;
    const shared = (await api.post(ann, '/reports', { kind: 'message', place: 'dm', messageId: dm.id, category: 'harassment', sharedText: 'you are awful' })).body;
    const { open } = (await api.get(mod, '/admin/reports')).body;
    expect(open.find((r) => r.id === quiet.id)).toMatchObject({ reported_id: bob.id, place: 'dm', content: null, shared: 0 });
    expect(open.find((r) => r.id === shared.id)).toMatchObject({ content: 'you are awful', shared: 1 });
  });

  it('reports a person, a limited number of times an hour', async () => {
    expect((await api.post(ann, '/reports', { kind: 'user', userId: bob.id, category: 'harassment' })).status).toBe(201);
    expect((await api.post(ann, '/reports', { kind: 'user', userId: ann.id, category: 'other' })).status).toBe(400);
    for (let i = 1; i < 20; i++) await api.post(ann, '/reports', { kind: 'user', userId: bob.id, category: 'other' });
    expect((await api.post(ann, '/reports', { kind: 'user', userId: bob.id, category: 'other' })).status).toBe(429);
  });

  it('is only for admins to read and act on', async () => {
    expect((await api.get(ann, '/admin/reports')).status).toBe(403);
    const report = (await api.post(ann, '/reports', { kind: 'user', userId: bob.id, category: 'spam' })).body;
    expect((await api.post(ann, `/admin/reports/${report.id}/dismiss`)).status).toBe(403);
    expect((await api.post(mod, `/admin/reports/${report.id}/dismiss`)).status).toBe(200);
    const after = (await api.get(mod, '/admin/reports')).body;
    expect(after.open.some((r) => r.id === report.id)).toBe(false);
    expect(after.resolved.find((r) => r.id === report.id)).toMatchObject({ action: 'dismissed', resolved_by: mod.id });
  });

  it('lets an admin delete a reported guild message', async () => {
    const msg = (await api.post(bob, `/channels/${channel.id}/messages`, { content: 'nasty' })).body;
    const report = (await api.post(ann, '/reports', { kind: 'message', place: 'guild', messageId: msg.id, category: 'hate' })).body;
    expect((await api.post(mod, `/admin/reports/${report.id}/delete-message`)).status).toBe(200);
    expect(await db.get('SELECT 1 FROM guild_messages WHERE id = ?', [msg.id])).toBeUndefined();
  });

  it('suspends an account: logged out everywhere, no logging in, until lifted', async () => {
    const bobSocket = listen(bob);
    const report = (await api.post(ann, '/reports', { kind: 'user', userId: bob.id, category: 'harassment' })).body;
    expect((await api.post(mod, `/admin/users/${mod.id}/suspend`)).status).toBe(400);
    expect((await api.post(mod, `/admin/users/${bob.id}/suspend`, { reason: 'Harassing people', reportId: report.id })).status).toBe(200);

    expect(bobSocket.events).toContainEqual({ type: 'account_suspended', reason: 'Harassing people' });
    expect(bobSocket.ws.closed).toBe(true);
    expect((await api.get(bob, '/profile')).status).toBe(403);
    const login = await loginUser(app, request, bob.username, PASSWORD);
    expect(login.response.status).toBe(403);
    expect(login.response.body).toMatchObject({ code: 'suspended', reason: 'Harassing people' });
    const { suspended, resolved } = (await api.get(mod, '/admin/reports')).body;
    expect(suspended.map((u) => u.id)).toContain(bob.id);
    expect(resolved.find((r) => r.id === report.id).action).toBe('suspended');

    expect((await api.delete(mod, `/admin/users/${bob.id}/suspension`)).status).toBe(200);
    expect((await loginUser(app, request, bob.username, PASSWORD)).response.status).toBe(200);
  });

  it('forgets resolved reports a year on', async () => {
    const { pruneReports } = require('../reports');
    const report = (await api.post(ann, '/reports', { kind: 'user', userId: bob.id, category: 'spam' })).body;
    await api.post(mod, `/admin/reports/${report.id}/dismiss`);
    await pruneReports(Math.floor(Date.now() / 1000) + 366 * 86400);
    expect(await db.get('SELECT 1 FROM reports WHERE id = ?', [report.id])).toBeUndefined();
  });
});
