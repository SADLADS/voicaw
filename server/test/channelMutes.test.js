import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { PERMISSIONS: P } = require('../permissions.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'mute-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-mutes-123';
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

// A connected socket for `user`, collecting its events.
function connect(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now() } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  Object.defineProperty(events, 'stop', {
    value: () => clients.set(String(user.id), clients.get(String(user.id)).filter((s) => s !== ws)),
  });
  return events;
}

async function subscribe(user) {
  const endpoint = `https://push.test/${user.username}`;
  await api.post(user, '/save-subscription', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
  return endpoint;
}

// A guild with an owner and `count` members (all subscribed to pushes), and its #general.
async function setUp(count = 2) {
  const owner = await makeUser('mute-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Quiet' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('mute-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    user.endpoint = await subscribe(user);
    members.push(user);
  }
  owner.endpoint = await subscribe(owner);
  return { owner, members, guild, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

const say = (user, channel, content) => api.post(user, `/channels/${channel.id}/messages`, { content });
const unreadFor = async (user, channel) => (await api.get(user, '/guild-unread')).body.find((u) => u.channel_id === channel.id);

// The pushes sent since `since` (after giving them time to go out).
async function pushesSince(since) {
  await waitForPushes(1000, since, 300);
  return sentPushes.slice(since);
}

describe('channel mutes', () => {
  it('mutes and unmutes a channel, listed per person, on your other devices too', async () => {
    const { members: [bob, carol], guild, general } = await setUp();
    const events = connect(bob);
    const res = await api.put(bob, `/channels/${general.id}/mute`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ guildId: guild.id, channelId: general.id, muted: true, until: null });
    expect(events).toContainEqual({ type: 'guild_channel_mute', ...res.body });
    expect((await api.get(bob, '/channel-mutes')).body).toEqual([{ channel_id: general.id, guild_id: guild.id, until: null }]);
    expect((await api.get(carol, '/channel-mutes')).body).toEqual([]);

    const before = Math.floor(Date.now() / 1000);
    const timed = await api.put(bob, `/channels/${general.id}/mute`, { duration: 3600 });
    expect(timed.body.until).toBeGreaterThanOrEqual(before + 3600);
    expect((await api.get(bob, '/channel-mutes')).body[0].until).toBe(timed.body.until);

    expect((await api.delete(bob, `/channels/${general.id}/mute`)).body.muted).toBe(false);
    expect((await api.get(bob, '/channel-mutes')).body).toEqual([]);
    events.stop();
  });

  it("refuses bad durations and channels you can't see", async () => {
    const { owner, members: [bob], guild, general, everyone } = await setUp(1);
    for (const duration of [0, -5, 1.5, 'soon', 400 * 24 * 3600]) {
      expect((await api.put(bob, `/channels/${general.id}/mute`, { duration })).status).toBe(400);
    }
    const secret = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'secret' })).body;
    await api.put(owner, `/guilds/${guild.id}/channels/${secret.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    expect((await api.put(bob, `/channels/${secret.id}/mute`, {})).status).toBe(404);
    const stranger = await makeUser();
    expect((await api.put(stranger, `/channels/${general.id}/mute`, {})).status).toBe(404);
  });

  it('stops pushes for plain messages, but not for mentions', async () => {
    const { owner, members: [bob, carol], guild, general } = await setUp();
    await api.put(bob, `/guilds/${guild.id}/notifications`, { level: 'all' });
    await api.put(carol, `/guilds/${guild.id}/notifications`, { level: 'all' });
    await api.put(bob, `/channels/${general.id}/mute`, {});

    let since = sentPushes.length;
    await say(owner, general, 'hello all');
    expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([carol.endpoint]);

    since = sentPushes.length;
    await say(owner, general, `hey <@${bob.id}>`);
    expect((await pushesSince(since)).map((p) => p.endpoint).sort()).toEqual([bob.endpoint, carol.endpoint].sort());
    // Unread counts are still kept (the app hides them for a muted channel), mentions included.
    expect(await unreadFor(bob, general)).toMatchObject({ count: 2, mentions: 1 });
  });

  it('ends by itself, and goes with leaving the guild or deleting the channel', async () => {
    const { owner, members: [bob], guild, general } = await setUp(1);
    await api.put(bob, `/guilds/${guild.id}/notifications`, { level: 'all' });
    await api.put(bob, `/channels/${general.id}/mute`, { duration: 60 });
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      const since = sentPushes.length;
      await say(owner, general, 'after the mute');
      expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([bob.endpoint]);
      expect((await api.get(bob, '/channel-mutes')).body).toEqual([]);
    } finally {
      Date.now = realNow;
    }

    const other = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'other' })).body;
    await api.put(bob, `/channels/${other.id}/mute`, {});
    await api.put(bob, `/channels/${general.id}/mute`, {});
    await api.delete(owner, `/guilds/${guild.id}/channels/${other.id}`);
    expect((await api.get(bob, '/channel-mutes')).body.map((m) => m.channel_id)).toEqual([general.id]);
    await api.delete(bob, `/guilds/${guild.id}/members/me`);
    expect((await api.get(bob, '/channel-mutes')).body).toEqual([]);
  });
});

describe('Mark As Read', () => {
  it('marks a channel read up to its newest message', async () => {
    const { owner, members: [bob], general } = await setUp(1);
    await say(owner, general, 'one');
    await say(owner, general, 'two');
    expect(await unreadFor(bob, general)).toMatchObject({ count: 2 });
    expect((await api.post(bob, `/channels/${general.id}/read`, { latest: true })).status).toBe(200);
    expect(await unreadFor(bob, general)).toBeUndefined();
    await say(owner, general, 'three');
    expect(await unreadFor(bob, general)).toMatchObject({ count: 1 });
  });
});

describe('channel notification levels', () => {
  it('sets, lists and clears your own level for a channel, on your other devices too', async () => {
    const { members: [bob, carol], guild, general } = await setUp();
    const events = connect(bob);
    const res = await api.put(bob, `/channels/${general.id}/notifications`, { level: 'all' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ guildId: guild.id, channelId: general.id, level: 'all' });
    expect(events).toContainEqual({ type: 'guild_channel_notify', ...res.body });
    expect((await api.get(bob, '/channel-notifications')).body).toEqual([{ channel_id: general.id, guild_id: guild.id, level: 'all' }]);
    expect((await api.get(carol, '/channel-notifications')).body).toEqual([]);
    expect((await api.put(bob, `/channels/${general.id}/notifications`, { level: null })).body.level).toBe(null);
    expect((await api.get(bob, '/channel-notifications')).body).toEqual([]);
    events.stop();
  });

  it("refuses bad levels and channels you can't see", async () => {
    const { owner, members: [bob], guild, general, everyone } = await setUp(1);
    for (const level of ['loud', 3, 'default']) {
      expect((await api.put(bob, `/channels/${general.id}/notifications`, { level })).status).toBe(400);
    }
    const secret = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'secret' })).body;
    await api.put(owner, `/guilds/${guild.id}/channels/${secret.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    expect((await api.put(bob, `/channels/${secret.id}/notifications`, { level: 'all' })).status).toBe(404);
  });

  it("overrides the guild's level for that channel only", async () => {
    const { owner, members: [bob, carol], guild, general } = await setUp();
    const other = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'other' })).body;
    // Bob: guild on mentions, #general on all. Carol: guild on all, #general on nothing.
    await api.put(bob, `/channels/${general.id}/notifications`, { level: 'all' });
    await api.put(carol, `/guilds/${guild.id}/notifications`, { level: 'all' });
    await api.put(carol, `/channels/${general.id}/notifications`, { level: 'none' });

    let since = sentPushes.length;
    await say(owner, general, 'in general');
    expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([bob.endpoint]);

    since = sentPushes.length;
    await say(owner, other, 'in other');
    expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([carol.endpoint]);

    // 'none' silences mentions too; a mute still beats 'all'.
    await api.put(bob, `/channels/${general.id}/mute`, {});
    since = sentPushes.length;
    await say(owner, general, `hey <@${carol.id}>`);
    expect(await pushesSince(since)).toEqual([]);
  });

  it('goes with leaving the guild or deleting the channel', async () => {
    const { owner, members: [bob], guild, general } = await setUp(1);
    const other = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'other' })).body;
    await api.put(bob, `/channels/${other.id}/notifications`, { level: 'none' });
    await api.put(bob, `/channels/${general.id}/notifications`, { level: 'all' });
    await api.delete(owner, `/guilds/${guild.id}/channels/${other.id}`);
    expect((await api.get(bob, '/channel-notifications')).body.map((m) => m.channel_id)).toEqual([general.id]);
    await api.delete(bob, `/guilds/${guild.id}/members/me`);
    expect((await api.get(bob, '/channel-notifications')).body).toEqual([]);
  });
});
