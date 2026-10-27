import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const { MAX_PINS } = require('../pins.js');
const { PERMISSIONS: P, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'pin-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-pins-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

const subscribe = (user) => api.post(user, '/save-subscription', {
  subscription: { endpoint: `https://push.test/${user.username}`, keys: { p256dh: 'p', auth: 'a' } },
});
const pushesTo = (user, pushes) => pushes.filter((p) => p.endpoint === `https://push.test/${user.username}`).map((p) => p.payload);

async function sendDm(from, to, content = 'ciphertext') {
  return (await api.post(from, '/dm-send', { recipient_id: to.id, content })).body.id;
}

describe('DM pins', () => {
  it('lets either person pin and unpin, and tells both', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const first = await sendDm(alice, bob, 'first');
    const second = await sendDm(bob, alice, 'second');
    const aliceEvents = listen(alice);

    const pinned = await api.put(bob, `/dm-messages/${first}/pin`);
    expect(pinned.status).toBe(200);
    expect(pinned.body).toEqual({ messageId: first, pinned_at: expect.any(Number), pinned_by: bob.id });
    expect(aliceEvents).toContainEqual(expect.objectContaining({ type: 'dm_pin', messageId: first, pinned_by: bob.id, sender_id: alice.id, recipient_id: bob.id }));
    expect((await api.put(alice, `/dm-messages/${second}/pin`)).status).toBe(200);

    // Messages carry it; the list is newest pin first.
    const page = (await api.get(alice, `/dm-messages/${bob.id}`)).body;
    expect(page.find((m) => m.id === first)).toMatchObject({ pinned_by: bob.id, pinned_at: expect.any(Number) });
    const pins = (await api.get(alice, `/dm-pins/${bob.id}`)).body;
    expect(pins.map((m) => m.id)).toEqual([second, first]);
    expect((await api.get(bob, `/dm-pins/${alice.id}`)).body.map((m) => m.id)).toEqual([second, first]);

    // Pinning again changes nothing (and says nothing).
    aliceEvents.length = 0;
    expect((await api.put(alice, `/dm-messages/${first}/pin`)).body.pinned_by).toBe(bob.id);
    expect(aliceEvents).toEqual([]);

    const unpinned = await api.delete(alice, `/dm-messages/${first}/pin`);
    expect(unpinned.body).toEqual({ messageId: first, pinned_at: null, pinned_by: null });
    expect(aliceEvents).toContainEqual(expect.objectContaining({ type: 'dm_pin', messageId: first, pinned_at: null }));
    expect((await api.get(bob, `/dm-pins/${alice.id}`)).body.map((m) => m.id)).toEqual([second]);
  });

  it("doesn't let anyone else pin, or see the pins", async () => {
    const [alice, bob, eve] = [await makeUser(), await makeUser(), await makeUser()];
    const id = await sendDm(alice, bob);
    await api.put(alice, `/dm-messages/${id}/pin`);
    expect((await api.put(eve, `/dm-messages/${id}/pin`)).status).toBe(404);
    expect((await api.delete(eve, `/dm-messages/${id}/pin`)).status).toBe(404);
    expect((await api.put(eve, '/dm-messages/999999/pin')).status).toBe(404);
    expect((await request(app).put(`/api/dm-messages/${id}/pin`)).status).toBe(401);
    // Eve's conversation with Alice has no pins.
    expect((await api.get(eve, `/dm-pins/${alice.id}`)).body).toEqual([]);
  });

  it('stops at the limit, per conversation', async () => {
    const [alice, bob, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const ids = [];
    for (let i = 0; i <= MAX_PINS; i++) ids.push(await sendDm(alice, bob, `m${i}`));
    // Pinned straight in the database (quicker than MAX_PINS requests).
    db.db.prepare(`UPDATE direct_messages SET pinned_at = 1, pinned_by = ? WHERE id IN (${ids.slice(0, MAX_PINS).join(',')})`).run(alice.id);

    const refused = await api.put(bob, `/dm-messages/${ids[MAX_PINS]}/pin`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/at most/);
    // Another conversation isn't affected.
    expect((await api.put(alice, `/dm-messages/${await sendDm(alice, cal)}/pin`)).status).toBe(200);
    // Unpinning one makes room.
    await api.delete(bob, `/dm-messages/${ids[0]}/pin`);
    expect((await api.put(bob, `/dm-messages/${ids[MAX_PINS]}/pin`)).status).toBe(200);
  });

  it('takes the pin away with a deleted message', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const id = await sendDm(alice, bob);
    await api.put(bob, `/dm-messages/${id}/pin`);
    await api.delete(alice, `/messages/${id}`);
    expect((await api.get(bob, `/dm-pins/${alice.id}`)).body).toEqual([]);
  });
});

describe('DM "pinned a message" rows', () => {
  it('posts one on pinning (not unpinning), unread for the other, and pushes it', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const id = await sendDm(alice, bob, 'v1.pinned-text');
    await api.post(bob, `/dm-mark-read/${alice.id}`);
    await subscribe(alice);
    const aliceEvents = listen(alice);
    const since = sentPushes.length;

    expect((await api.put(bob, `/dm-messages/${id}/pin`)).status).toBe(200);
    const row = aliceEvents.find((e) => e.type === 'new_dm')?.message;
    expect(row).toMatchObject({ system: 'pin', sender_id: bob.id, recipient_id: alice.id, parent_message_id: id, content: '' });
    expect((await api.get(alice, `/dm-messages/${bob.id}`)).body.at(-1)).toMatchObject({ id: row.id, system: 'pin' });
    expect((await api.get(alice, '/dm-get-unread')).body).toMatchObject([{ from_user_id: bob.id, count: 1 }]);
    const [push] = pushesTo(alice, await waitForPushes(1, since));
    expect(push).toMatchObject({
      type: 'dm', system: 'pin', tag: `dm-${bob.id}`, url: `/dm/${bob.id}`, senderId: bob.id, recipientId: alice.id,
      messageId: id, messageSenderId: alice.id, messageRecipientId: bob.id, messageCiphertext: 'v1.pinned-text',
    });
    expect(push.ciphertext).toBeUndefined();

    // Unpinning posts nothing; the row itself can't be pinned or edited.
    await api.delete(alice, `/dm-messages/${id}/pin`);
    expect(aliceEvents.filter((e) => e.type === 'new_dm')).toHaveLength(1);
    expect((await api.put(alice, `/dm-messages/${row.id}/pin`)).status).toBe(400);
    expect((await api.put(bob, `/update-message/${row.id}`, { content: 'v1.x' })).status).toBe(403);

    // Deleting the pinned message takes its rows.
    await api.put(alice, `/dm-messages/${id}/pin`);
    await api.delete(alice, `/messages/${id}`);
    expect((await api.get(bob, `/dm-messages/${alice.id}`)).body).toEqual([]);
  });

  it("doesn't push in notes, or to someone looking at the chat", async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    await subscribe(alice);
    const note = await sendDm(alice, alice, 'v1.note');
    const id = await sendDm(bob, alice);
    const since = sentPushes.length;
    await api.put(alice, `/dm-messages/${note}/pin`);
    listen(alice);
    clients.get(String(alice.id)).at(-1).presence = { at: Date.now(), visible: true, chatId: String(bob.id) };
    await api.put(bob, `/dm-messages/${id}/pin`);
    await new Promise((r) => setTimeout(r, 100));
    expect(pushesTo(alice, sentPushes.slice(since))).toEqual([]);
  });
});

// A guild with an owner and two members, and its #general.
async function setUpGuild() {
  const owner = await makeUser('pin-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Pins Guild' })).body;
  const members = [];
  for (let i = 0; i < 2; i++) {
    const user = await makeUser('pin-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  return { owner, members, guild, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

const post = async (user, channel, content) => (await api.post(user, `/channels/${channel.id}/messages`, { content })).body.id;

describe('guild channel pins', () => {
  it("isn't something @everyone can do by default", () => {
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.PIN_MESSAGES).toBe(0);
  });

  it('needs Pin Messages', async () => {
    const { owner, members: [alice, bob], guild, general } = await setUpGuild();
    const id = await post(alice, general, 'pin me');
    const bobEvents = listen(bob);

    expect((await api.put(alice, `/guild-messages/${id}/pin`)).status).toBe(403);

    // The owner has every permission.
    const pinned = await api.put(owner, `/guild-messages/${id}/pin`);
    expect(pinned.status).toBe(200);
    expect(pinned.body).toMatchObject({ messageId: id, pinned_by: owner.id });
    expect(bobEvents).toContainEqual(expect.objectContaining({ type: 'guild_message_pin', guildId: guild.id, channelId: general.id, messageId: id, pinned_by: owner.id }));

    // Everyone who can see the channel sees the pins; the messages carry it.
    expect((await api.get(bob, `/channels/${general.id}/pins`)).body.map((m) => m.id)).toEqual([id]);
    const page = (await api.get(bob, `/channels/${general.id}/messages`)).body;
    expect(page.find((m) => m.id === id).pinned_by).toBe(owner.id);

    // A role with Pin Messages can pin and unpin.
    const pinners = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Pinners', permissions: P.PIN_MESSAGES })).body;
    await api.put(owner, `/guilds/${guild.id}/members/${alice.id}/roles`, { roleIds: [pinners.id] });
    expect((await api.delete(alice, `/guild-messages/${id}/pin`)).body.pinned_at).toBe(null);
    expect((await api.get(bob, `/channels/${general.id}/pins`)).body).toEqual([]);
    expect((await api.put(bob, `/guild-messages/${id}/pin`)).status).toBe(403);
  });

  it('follows channel overrides', async () => {
    const { owner, members: [alice], guild, general, everyone } = await setUpGuild();
    const id = await post(owner, general, 'hello');
    const base = `/guilds/${guild.id}/channels/${general.id}/overrides`;
    expect((await api.put(owner, `${base}/role/${everyone.id}`, { allow: P.PIN_MESSAGES })).status).toBe(200);
    expect((await api.put(alice, `/guild-messages/${id}/pin`)).status).toBe(200);
    await api.put(owner, `${base}/member/${alice.id}`, { deny: P.PIN_MESSAGES });
    expect((await api.delete(alice, `/guild-messages/${id}/pin`)).status).toBe(403);
  });

  it('posts a "pinned" row and pushes it to the author of the message', async () => {
    const { owner, members: [alice, bob], general } = await setUpGuild();
    const id = await post(alice, general, 'pin me <@' + bob.id + '>');
    for (const user of [owner, alice, bob]) await subscribe(user);
    const bobEvents = listen(bob);
    const since = sentPushes.length;
    await api.put(owner, `/guild-messages/${id}/pin`);
    const row = bobEvents.find((e) => e.type === 'guild_message_new')?.message;
    expect(row).toMatchObject({ system: 'pin', sender_id: owner.id, parent_message_id: id, content: '' });
    await waitForPushes(1, since);
    await new Promise((r) => setTimeout(r, 100));
    const pushes = sentPushes.slice(since);
    // Bob's level is Mentions, and the pin isn't about him.
    expect(pushesTo(bob, pushes)).toEqual([]);
    expect(pushesTo(owner, pushes)).toEqual([]);
    expect(pushesTo(alice, pushes)).toEqual([expect.objectContaining({
      type: 'guild', system: 'pin', tag: `channel-${general.id}`, preview: `pin me @${bob.username}`,
    })]);
    // Bots see Discord's CHANNEL_PINNED_MESSAGE.
    const { messageObjects } = require('../discord.js');
    const [object] = await messageObjects([row]);
    expect(object).toMatchObject({ type: 6, message_reference: { message_id: String(id) } });
  });

  it("hides a private channel's pins from those who can't see it", async () => {
    const { owner, members: [alice], guild, general, everyone } = await setUpGuild();
    const id = await post(owner, general, 'secret');
    await api.put(owner, `/guild-messages/${id}/pin`);
    await api.put(owner, `/guilds/${guild.id}/channels/${general.id}/overrides/role/${everyone.id}`, { deny: P.VIEW_CHANNEL });
    expect((await api.get(alice, `/channels/${general.id}/pins`)).status).toBe(404);
    expect((await api.delete(alice, `/guild-messages/${id}/pin`)).status).toBe(404);
  });
});
