import './helpers/mockS3.js';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { AccessToken } from 'livekit-server-sdk';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const voice = require('../voice.js');
const { PERMISSIONS: P, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');
const { toDiscordPermissions } = require('../discord.js');
const clients = app.locals.clients;

// LiveKit itself isn't there: this records what the API asks of each region's server.
const calls = [];
const fakeService = (region) => ({
  removeParticipant: async (room, identity) => { calls.push(['remove', region, room, identity]); },
  updateParticipant: async (room, identity) => { calls.push(['update', region, room, identity]); },
  deleteRoom: async (room) => { calls.push(['deleteRoom', region, room]); },
  listParticipants: async () => [],
  listRooms: async () => [],
});
voice.livekit.roomService = fakeService('main');
voice.livekit.connect = (connection) => fakeService(connection.url);
beforeEach(() => { calls.length = 0; });

let userCount = 0;
async function makeUser(prefix = 'vr-user', { admin = false } = {}) {
  const username = `${prefix}-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-regions-1');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-regions-1');
  if (admin) await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [regRes.body.id]);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}
const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};
const discord = {
  get: (bot, url) => request(app).get(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }),
  patch: (bot, url, body = {}) => request(app).patch(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }).send(body),
};

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

// A webhook as a region's LiveKit sends it: signed with that server's key.
let sidCount = 0;
async function webhook(event, channel, user, { key = process.env.LIVEKIT_API_KEY, secret = process.env.LIVEKIT_API_SECRET, sid = `PA_${++sidCount}` } = {}) {
  const body = JSON.stringify({
    event,
    id: `EV_${++sidCount}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { name: `channel-${channel.id}` },
    participant: user && { sid, identity: String(user.id), name: user.username },
  });
  const token = new AccessToken(key, secret);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  const res = await request(app).post('/api/livekit/webhook').set('Authorization', await token.toJwt())
    .set('Content-Type', 'application/webhook+json').send(body);
  return { status: res.status, sid };
}

async function setUp() {
  const owner = await makeUser('vr-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Regions' })).body;
  const member = await makeUser('vr-member');
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  await api.post(member, `/invites/${invite.body.code}`);
  const lounge = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' })).body;
  return { owner, member, guild, lounge, general: guild.channels[0] };
}

const join = (user, guild, channel) => api.post(user, `/guilds/${guild.id}/channels/${channel.id}/voice`);
const channelIn = async (user, guild, channel) => (await api.get(user, `/guilds/${guild.id}`)).body.channels.find((c) => c.id === channel.id);

let regionCount = 0;
const newRegion = (overrides = {}) => {
  const n = ++regionCount;
  return { name: `Region ${n}`, flag: '🇩🇪', url: `wss://rtc${n}.example.com`, apiKey: `key-${n}`, apiSecret: `secret-${n}-that-is-long-enough`, ...overrides };
};
async function addRegion(admin, body = newRegion()) {
  const res = await api.post(admin, '/admin/voice-regions', body);
  expect(res.status).toBe(201);
  return { ...body, ...res.body.find((r) => r.name === body.name) };
}

describe('voice channel settings', () => {
  it('start at 64 kbps, no user limit and Automatic; only voice channels have them', async () => {
    const { owner, guild, lounge, general } = await setUp();
    expect(lounge).toMatchObject({ bitrate: 64000, user_limit: 0, rtc_region: null });
    expect(await channelIn(owner, guild, lounge)).toMatchObject({ bitrate: 64000, user_limit: 0, rtc_region: null });
    expect(await channelIn(owner, guild, general)).not.toHaveProperty('bitrate');
    const res = await api.patch(owner, `/guilds/${guild.id}/channels/${general.id}`, { bitrate: 96000 });
    expect(res.status).toBe(400);
  });

  it('take a bitrate of 8–384 kbps and a user limit of 0–99, from Manage Channels only', async () => {
    const { owner, member, guild, lounge } = await setUp();
    const url = `/guilds/${guild.id}/channels/${lounge.id}`;
    for (const bad of [{ bitrate: 7999 }, { bitrate: 384001 }, { bitrate: '96000' }, { userLimit: 100 }, { userLimit: -1 }, { userLimit: 1.5 }]) {
      expect((await api.patch(owner, url, bad)).status).toBe(400);
    }
    expect((await api.patch(member, url, { bitrate: 96000 })).status).toBe(403);
    const res = await api.patch(owner, url, { bitrate: 384000, userLimit: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bitrate: 384000, user_limit: 5 });
    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body;
    const entry = (log.entries ?? log).find((e) => e.action === 'channel_update');
    expect(entry.details.changes).toMatchObject({ bitrate: [64000, 384000], user_limit: [0, 5] });
  });

  it('can be set when the channel is made, and are copied with it', async () => {
    const { owner, guild } = await setUp();
    const made = await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Music', type: 'voice', bitrate: 128000, userLimit: 3 });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ bitrate: 128000, user_limit: 3 });
    expect((await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'chat', type: 'text', bitrate: 128000 })).status).toBe(400);
    const copy = await api.post(owner, `/guilds/${guild.id}/channels/${made.body.id}/clone`, {});
    expect(copy.body).toMatchObject({ bitrate: 128000, user_limit: 3 });
  });

  it('send the bitrate with the join token, and to the people in the channel when it changes', async () => {
    const { owner, member, guild, lounge } = await setUp();
    await api.patch(owner, `/guilds/${guild.id}/channels/${lounge.id}`, { bitrate: 96000 });
    expect((await join(member, guild, lounge)).body.bitrate).toBe(96000);
    await webhook('participant_joined', lounge, member);
    const events = listen(member);
    await api.patch(owner, `/guilds/${guild.id}/channels/${lounge.id}`, { bitrate: 128000 });
    expect(events.filter((e) => e.type === 'guild_voice_channel')).toEqual([
      { type: 'guild_voice_channel', guildId: guild.id, channelId: lounge.id, bitrate: 128000, moved: false },
    ]);
  });

  it('turn people away once the user limit is reached, except those with Manage Channels', async () => {
    const { owner, member, guild, lounge } = await setUp();
    const third = await makeUser('vr-third');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(third, `/invites/${invite.body.code}`);
    await api.patch(owner, `/guilds/${guild.id}/channels/${lounge.id}`, { userLimit: 1 });
    expect((await join(member, guild, lounge)).status).toBe(200);
    await webhook('participant_joined', lounge, member);
    const full = await join(third, guild, lounge);
    expect(full.status).toBe(403);
    expect(full.body.error).toBe('This voice channel is full');
    // Already in it: a new token (a rejoin) is fine.
    expect((await join(member, guild, lounge)).status).toBe(200);
    expect((await join(owner, guild, lounge)).status).toBe(200);
  });
});

describe('voice regions', () => {
  it('start with the main one (.env), the default; only admins see or change them', async () => {
    const admin = await makeUser('vr-admin', { admin: true });
    const someone = await makeUser();
    const list = (await api.get(admin, '/admin')).body.voiceRegions;
    const main = list.find((r) => r.builtin);
    expect(main).toMatchObject({ name: 'Main', builtin: true, available: true, url: process.env.LIVEKIT_URL, api_key: process.env.LIVEKIT_API_KEY });
    expect(main.secret_hint).toBe(`…${process.env.LIVEKIT_API_SECRET.slice(-4)}`);
    expect(JSON.stringify(list)).not.toContain(process.env.LIVEKIT_API_SECRET);
    expect((await api.post(someone, '/admin/voice-regions', newRegion())).status).toBe(403);
    expect((await api.get(someone, '/voice/regions')).body.find((r) => r.id === main.id)).toEqual({ id: main.id, name: 'Main', flag: '', default: expect.any(Boolean) });
    // Its server is .env's: only its name and flag change here.
    expect((await api.patch(admin, `/admin/voice-regions/${main.id}`, { url: 'wss://elsewhere.example.com' })).status).toBe(400);
    expect((await api.delete(admin, `/admin/voice-regions/${main.id}`)).status).toBe(400);
  });

  it('check what admins enter and never show a secret', async () => {
    const admin = await makeUser('vr-admin', { admin: true });
    for (const bad of [
      newRegion({ name: '' }), newRegion({ url: 'https://rtc.example.com' }), newRegion({ apiKey: '' }),
      newRegion({ apiSecret: '' }), newRegion({ apiKey: process.env.LIVEKIT_API_KEY }), newRegion({ apiUrl: 'ftp://x' }),
    ]) {
      expect((await api.post(admin, '/admin/voice-regions', bad)).status).toBe(400);
    }
    const region = await addRegion(admin);
    expect(region).toMatchObject({ builtin: false, available: true, api_key: region.apiKey, secret_hint: `…${region.apiSecret.slice(-4)}` });
    const listed = (await api.get(admin, '/admin')).body;
    expect(JSON.stringify(listed)).not.toContain(region.apiSecret);
    // An empty secret keeps the old one.
    const renamed = await api.patch(admin, `/admin/voice-regions/${region.id}`, { name: 'Frankfurt', apiSecret: '' });
    expect(renamed.body.find((r) => r.id === region.id)).toMatchObject({ name: 'Frankfurt', secret_hint: region.secret_hint });
  });

  it('put a voice channel on another LiveKit server: tokens and webhooks are that server\'s', async () => {
    const admin = await makeUser('vr-admin', { admin: true });
    const region = await addRegion(admin);
    const { owner, member, guild, lounge } = await setUp();
    const url = `/guilds/${guild.id}/channels/${lounge.id}`;
    expect((await api.patch(owner, url, { rtcRegion: 999999 })).status).toBe(400);
    expect((await api.patch(owner, url, { rtcRegion: region.id })).body.rtc_region).toBe(region.id);

    const res = await join(member, guild, lounge);
    expect(res.body.url).toBe(region.url);
    expect(jwt.verify(res.body.token, region.apiSecret)).toMatchObject({ iss: region.apiKey, sub: String(member.id) });

    // Its webhooks count; the main server saying someone joined this channel doesn't (an old token).
    expect((await webhook('participant_joined', lounge, member, { key: region.apiKey, secret: region.apiSecret })).status).toBe(200);
    expect((await channelIn(owner, guild, lounge)).voice.map((s) => s.user_id)).toEqual([member.id]);
    const stale = await webhook('participant_joined', lounge, owner);
    expect(stale.status).toBe(200);
    expect(calls).toContainEqual(['remove', 'main', `channel-${lounge.id}`, String(owner.id)]);
    expect((await channelIn(owner, guild, lounge)).voice.map((s) => s.user_id)).toEqual([member.id]);
    // The old room finishing on the main server leaves the people on the new one be.
    await webhook('room_finished', lounge, null);
    expect((await channelIn(owner, guild, lounge)).voice).toHaveLength(1);

    // A webhook signed with no region's key is refused.
    expect((await webhook('participant_left', lounge, member, { key: 'nobody', secret: 'not-a-region-secret-at-all' })).status).toBe(401);
    // Leaving goes to the region's server.
    await api.delete(member, '/voice');
    expect(calls).toContainEqual(['remove', region.url, `channel-${lounge.id}`, String(member.id)]);
  });

  it('move the people in a channel when its region changes: their apps rejoin, the old sessions end', async () => {
    const admin = await makeUser('vr-admin', { admin: true });
    const region = await addRegion(admin);
    const { owner, member, guild, lounge } = await setUp();
    await join(member, guild, lounge);
    const { sid } = await webhook('participant_joined', lounge, member);
    const events = listen(member);
    await api.patch(owner, `/guilds/${guild.id}/channels/${lounge.id}`, { rtcRegion: region.id });
    expect(events.filter((e) => e.type === 'guild_voice_channel')).toEqual([
      { type: 'guild_voice_channel', guildId: guild.id, channelId: lounge.id, bitrate: 64000, moved: true },
    ]);
    // The app joins again there: its old session on the main server is ended.
    expect((await join(member, guild, lounge)).body.url).toBe(region.url);
    await webhook('participant_joined', lounge, member, { key: region.apiKey, secret: region.apiSecret });
    expect(calls).toContainEqual(['remove', 'main', `channel-${lounge.id}`, String(member.id)]);
    // Its "left" from the main server doesn't take them out.
    await webhook('participant_left', lounge, member, { sid });
    expect((await channelIn(owner, guild, lounge)).voice.map((s) => s.user_id)).toEqual([member.id]);
  });

  it('send calls and Automatic channels to the default; removing a region puts its channels back on Automatic', async () => {
    const admin = await makeUser('vr-admin', { admin: true });
    const region = await addRegion(admin);
    const { owner, member, guild, lounge } = await setUp();
    const main = (await api.get(admin, '/admin')).body.voiceRegions.find((r) => r.builtin);

    await join(member, guild, lounge);
    await webhook('participant_joined', lounge, member);
    const events = listen(member);
    // A new default moves those in Automatic channels.
    const res = await api.patch(admin, `/admin/voice-regions/${region.id}`, { default: true });
    expect(res.body.find((r) => r.id === region.id).default).toBe(true);
    expect(res.body.filter((r) => r.default)).toHaveLength(1);
    expect(events.some((e) => e.type === 'guild_voice_channel' && e.moved)).toBe(true);
    expect((await join(member, guild, lounge)).body.url).toBe(region.url);

    // Pinned to it, then it's removed: back on Automatic (the main server, default again).
    await api.patch(owner, `/guilds/${guild.id}/channels/${lounge.id}`, { rtcRegion: region.id });
    expect((await api.delete(admin, `/admin/voice-regions/${region.id}`)).status).toBe(200);
    expect((await channelIn(owner, guild, lounge)).rtc_region).toBe(null);
    const after = (await api.get(admin, '/admin')).body.voiceRegions;
    expect(after.find((r) => r.id === main.id).default).toBe(true);
    expect((await join(member, guild, lounge)).body.url).toBe(process.env.LIVEKIT_URL);
  });
});

describe('voice channel settings in the bot API', () => {
  it('shows and changes bitrate, user_limit and rtc_region, and lists the regions', async () => {
    const admin = await makeUser('vr-admin', { admin: true });
    const region = await addRegion(admin);
    const { owner, guild, lounge } = await setUp();
    const created = await api.post(owner, '/applications', { name: 'Tuner' });
    const bot = { id: created.body.id, token: created.body.token };
    await api.post(owner, '/oauth2/authorize', {
      client_id: bot.id, guild_id: guild.id, permissions: toDiscordPermissions(DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_CHANNELS),
    });
    expect((await discord.get(bot, `/channels/${lounge.id}`)).body).toMatchObject({ bitrate: 64000, user_limit: 0, rtc_region: null });
    const res = await discord.patch(bot, `/channels/${lounge.id}`, { bitrate: 96000, user_limit: 10, rtc_region: String(region.id) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bitrate: 96000, user_limit: 10, rtc_region: String(region.id) });
    expect((await discord.patch(bot, `/channels/${lounge.id}`, { bitrate: 1000 })).status).toBe(400);
    const regions = (await discord.get(bot, '/voice/regions')).body;
    expect(regions).toContainEqual({ id: String(region.id), name: region.name, optimal: false, deprecated: false, custom: false });
  });
});
