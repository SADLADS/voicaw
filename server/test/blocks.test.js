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
  patch: (u, url, body = {}) => request(app).patch(`/api${url}`).set(authed(u)).send(body),
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
    expect((await api.get(ann, '/blocks')).body).toEqual({ blocked: [], webhooks: [] });
    expect((await api.put(ann, `/blocks/${bob.id}`)).body).toEqual({ blocked: [bob.id], webhooks: [] });
    expect(events).toContainEqual({ type: 'blocks', blocked: [bob.id], webhooks: [] });
    expect((await api.put(ann, `/blocks/${ann.id}`)).status).toBe(400);
    expect((await api.put(ann, '/blocks/999999')).status).toBe(404);
    expect((await api.delete(ann, `/blocks/${bob.id}`)).body).toEqual({ blocked: [], webhooks: [] });
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

  it('stops edits, link previews, pins and new reactions in the conversation too, both ways', async () => {
    const reaction = `v1.${'A'.repeat(123)}=`; // a 64-byte reaction, as calls.test.js
    const old = (await api.post(bob, '/dm-send', { recipient_id: ann.id, content })).body;
    const mine = (await api.post(ann, '/dm-send', { recipient_id: bob.id, content })).body;
    expect((await api.post(bob, '/dm-reactions', { messageId: mine.id, content: reaction })).status).toBe(201);
    expect((await api.put(bob, `/dm-messages/${old.id}/pin`)).status).toBe(200);
    await api.put(ann, `/blocks/${bob.id}`);
    const annEvents = listen(ann);
    const refused = [
      await api.put(bob, `/update-message/${old.id}`, { content: `v1.${'B'.repeat(40)}` }),
      await api.put(bob, `/dm-messages/${old.id}/link-previews`, { previews: 'v1.xyz' }),
      await api.put(bob, `/dm-messages/${mine.id}/pin`),
      await api.post(bob, '/dm-reactions', { messageId: mine.id, content: reaction }),
      // The one who blocked can't carry on either (as with sending).
      await api.put(ann, `/update-message/${mine.id}`, { content: `v1.${'B'.repeat(40)}` }),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('blocked');
    }
    expect(annEvents).toEqual([]);
    // Unpinning and deleting your own things still work.
    expect((await api.delete(bob, `/dm-messages/${old.id}/pin`)).status).toBe(200);
    expect((await api.delete(bob, `/messages/${old.id}`)).status).toBeLessThan(300);
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

describe('blocking webhooks', () => {
  // Bob's guild, Ann in it, and a webhook in its first channel.
  async function setUp() {
    const guild = (await api.post(bob, '/guilds', { name: 'Hooks' })).body;
    const invite = (await api.post(bob, `/guilds/${guild.id}/invites`)).body;
    await api.post(ann, `/invites/${invite.code}`);
    const channel = guild.channels[0];
    const hook = (await api.post(bob, `/channels/${channel.id}/webhooks`, { name: 'Spam Bot' })).body;
    const post = (body) => request(app).post(`/api/webhooks/${hook.id}/${hook.token}`).send(body);
    return { guild, channel, hook, post };
  }

  it('blocks and unblocks a webhook of a guild you are in, telling your other devices', async () => {
    const { guild, hook } = await setUp();
    const events = listen(ann);
    const entry = { id: Number(hook.id), name: 'Spam Bot', guild_id: guild.id, guild_name: 'Hooks' };
    expect((await api.put(ann, `/blocks/webhooks/${hook.id}`)).body).toEqual({ blocked: [], webhooks: [entry] });
    expect(events).toContainEqual({ type: 'blocks', blocked: [], webhooks: [entry] });
    // Twice is fine; the list follows a rename.
    await api.put(ann, `/blocks/webhooks/${hook.id}`);
    await api.patch(bob, `/webhooks/${hook.id}`, { name: 'Renamed' });
    expect((await api.get(ann, '/blocks')).body.webhooks).toEqual([{ ...entry, name: 'Renamed' }]);
    expect((await api.delete(ann, `/blocks/webhooks/${hook.id}`)).body).toEqual({ blocked: [], webhooks: [] });
  });

  it("refuses a webhook you can't have seen, or none", async () => {
    const { hook } = await setUp();
    const carol = await makeUser();
    expect((await api.put(carol, `/blocks/webhooks/${hook.id}`)).status).toBe(404);
    expect((await api.put(ann, '/blocks/webhooks/999999')).status).toBe(404);
    expect((await api.put(ann, '/blocks/webhooks/nope')).status).toBe(400);
  });

  it("refuses a webhook in a channel you can't see, and drops its new names once you've left", async () => {
    const { guild, hook } = await setUp();
    const secret = (await api.post(bob, `/guilds/${guild.id}/channels`, { name: 'secret', private: true })).body;
    const hidden = (await api.post(bob, `/channels/${secret.id}/webhooks`, { name: 'Hidden Hook' })).body;
    expect((await api.put(ann, `/blocks/webhooks/${hidden.id}`)).status).toBe(404);
    // A message of it in a channel ann can see is enough.
    const moved = (await api.post(bob, `/channels/${secret.id}/webhooks`, { name: 'Mover' })).body;
    await api.patch(bob, `/webhooks/${moved.id}`, { channel_id: String(guild.channels[0].id) });
    await request(app).post(`/api/webhooks/${moved.id}/${moved.token}`).send({ content: 'hi' });
    await api.patch(bob, `/webhooks/${moved.id}`, { channel_id: String(secret.id) });
    expect((await api.put(ann, `/blocks/webhooks/${moved.id}`)).status).toBe(200);

    await api.put(ann, `/blocks/webhooks/${hook.id}`);
    expect((await api.delete(ann, `/guilds/${guild.id}/members/me`)).status).toBe(200);
    await api.patch(bob, `/webhooks/${hook.id}`, { name: 'Secret Plans' });
    expect((await api.get(ann, '/blocks')).body.webhooks.map((w) => w.name)).not.toContain('Secret Plans');
  });

  it('keeps the block (and its name) once the webhook is deleted, as its messages stay', async () => {
    const { hook, post } = await setUp();
    expect((await post({ content: 'hello' })).status).toBe(204);
    await api.put(ann, `/blocks/webhooks/${hook.id}`);
    expect((await api.delete(bob, `/webhooks/${hook.id}`)).status).toBe(204);
    expect((await api.get(ann, '/blocks')).body.webhooks).toMatchObject([{ id: Number(hook.id), name: 'Spam Bot' }]);
    // A deleted webhook can still be blocked from its messages (by someone in that guild).
    await api.delete(ann, `/blocks/webhooks/${hook.id}`);
    expect((await api.put(ann, `/blocks/webhooks/${hook.id}`)).body.webhooks).toMatchObject([{ id: Number(hook.id), name: 'Spam Bot' }]);
  });

  it("doesn't push a blocked webhook's mentions, and goes with the guild", async () => {
    const { guild, hook, post } = await setUp();
    await api.post(ann, '/save-subscription', { subscription: { endpoint: `https://push.test/${ann.id}`, keys: { p256dh: 'p', auth: 'a' } } });
    let since = sentPushes.length;
    await post({ content: `hi <@${ann.id}>` });
    expect((await waitForPushes(1, since)).some((p) => p.endpoint === `https://push.test/${ann.id}`)).toBe(true);
    await api.put(ann, `/blocks/webhooks/${hook.id}`);
    since = sentPushes.length;
    await post({ content: `again <@${ann.id}>` });
    expect((await waitForPushes(1, since, 500)).some((p) => p.endpoint === `https://push.test/${ann.id}`)).toBe(false);

    expect((await api.delete(bob, `/guilds/${guild.id}`)).status).toBeLessThan(300);
    expect((await api.get(ann, '/blocks')).body.webhooks).toEqual([]);
  });
});
