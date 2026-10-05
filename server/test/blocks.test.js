import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');
const clients = app.locals.clients;

let count = 0;
async function makeUser() {
  const username = `block-${++count}`;
  const { response } = await registerUser(app, request, username, 'pw-block-123');
  const login = await loginUser(app, request, username, 'pw-block-123');
  return { id: response.body.id, username, token: login.response.body.token };
}
const authed = (u) => ({ Authorization: `Bearer ${u.token}` });
const api = {
  get: (u, url) => request(app).get(`/api${url}`).set(authed(u)),
  put: (u, url, body = {}) => request(app).put(`/api${url}`).set(authed(u)).send(body),
  post: (u, url, body = {}) => request(app).post(`/api${url}`).set(authed(u)).send(body),
  delete: (u, url) => request(app).delete(`/api${url}`).set(authed(u)),
};
function listen(user) {
  const events = [];
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), { readyState: 1, send: (m) => events.push(JSON.parse(m)) }]);
  return events;
}
const content = `v1.${'A'.repeat(40)}`;

let ann;
let bob;
beforeEach(async () => {
  ann = await makeUser();
  bob = await makeUser();
});

describe('blocking', () => {
  it('lists, adds and removes blocks, telling your other devices', async () => {
    const events = listen(ann);
    expect((await api.get(ann, '/blocks')).body).toEqual({ blocked: [] });
    expect((await api.put(ann, `/blocks/${bob.id}`)).body).toEqual({ blocked: [bob.id] });
    expect(events).toContainEqual({ type: 'blocks', blocked: [bob.id] });
    expect((await api.put(ann, `/blocks/${ann.id}`)).status).toBe(400);
    expect((await api.put(ann, '/blocks/999999')).status).toBe(404);
    expect((await api.delete(ann, `/blocks/${bob.id}`)).body).toEqual({ blocked: [] });
    expect((await request(app).get('/api/blocks')).status).toBe(401);
  });

  it('stops DMs and calls both ways, without telling the blocked person why', async () => {
    expect((await api.post(bob, '/dm-send', { recipient_id: ann.id, content })).status).toBe(201);
    await api.put(ann, `/blocks/${bob.id}`);
    const fromBob = await api.post(bob, '/dm-send', { recipient_id: ann.id, content });
    expect(fromBob.status).toBe(403);
    expect(fromBob.body.error).not.toMatch(/block/i);
    expect((await api.post(ann, '/dm-send', { recipient_id: bob.id, content })).status).toBe(403);
    const call = await api.post(bob, '/dm-calls', { calleeId: ann.id, callId: randomUUID(), keyEnvelope: `v1.${'A'.repeat(100)}` });
    expect(call.status).toBe(403);
    // Unblocked, they can talk again.
    await api.delete(ann, `/blocks/${bob.id}`);
    expect((await api.post(bob, '/dm-send', { recipient_id: ann.id, content })).status).toBe(201);
  });

  it("doesn't push guild mentions from someone you blocked", async () => {
    const guild = (await api.post(ann, '/guilds', { name: 'Place' })).body;
    const invite = (await api.post(ann, `/guilds/${guild.id}/invites`)).body;
    await api.post(bob, `/invites/${invite.code}`);
    await api.post(ann, '/save-subscription', { subscription: { endpoint: `https://push.test/${ann.id}`, keys: { p256dh: 'p', auth: 'a' } } });
    const channel = guild.channels[0];
    let since = sentPushes.length;
    await api.post(bob, `/channels/${channel.id}/messages`, { content: `hi <@${ann.id}>` });
    expect((await waitForPushes(1, since)).some((p) => p.endpoint === `https://push.test/${ann.id}`)).toBe(true);
    await api.put(ann, `/blocks/${bob.id}`);
    since = sentPushes.length;
    await api.post(bob, `/channels/${channel.id}/messages`, { content: `again <@${ann.id}>` });
    expect((await waitForPushes(1, since, 500)).some((p) => p.endpoint === `https://push.test/${ann.id}`)).toBe(false);
  });
});
