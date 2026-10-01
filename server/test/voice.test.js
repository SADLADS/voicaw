import './helpers/mockS3.js';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const voice = require('../voice.js');
const { PERMISSIONS: P } = require('../permissions.js');
const clients = app.locals.clients;

// LiveKit itself isn't there: this records what the API asks of it.
const calls = [];
voice.livekit.roomService = {
  removeParticipant: async (room, identity) => { calls.push(['remove', room, identity]); },
  updateParticipant: async (room, identity, options) => { calls.push(['update', room, identity, options]); },
};

let userCount = 0;
async function makeUser(prefix = 'voice-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-voice-123';
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
const voiceEvents = (events) => events.filter((e) => e.type === 'guild_voice_state');

// A guild with an owner, `count` members, a text channel (#general) and two voice channels.
async function setUp(count = 1) {
  const owner = await makeUser('owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Voice Guild' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  const lounge = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' })).body;
  const gaming = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Gaming', type: 'voice' })).body;
  return { owner, members, guild, general: guild.channels[0], lounge, gaming, everyone: guild.roles.find((r) => r.is_everyone) };
}

const join = (user, guild, channel, body) => api.post(user, `/guilds/${guild.id}/channels/${channel.id}/voice`, body);

// A webhook as LiveKit sends it: signed with the API key, carrying the body's hash.
let sidCount = 0;
async function webhook(event, channel, user, sid = `PA_${++sidCount}`, track) {
  const body = JSON.stringify({
    event,
    id: `EV_${sidCount}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { name: `channel-${channel.id}` },
    participant: user && { sid, identity: String(user.id), name: user.username },
    ...(track && { track }),
  });
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  const res = await request(app).post('/api/livekit/webhook')
    .set('Authorization', await token.toJwt())
    .set('Content-Type', 'application/webhook+json')
    .send(body);
  expect(res.status).toBe(200);
  return sid;
}

const voiceOf = async (user, guild, channel) =>
  (await api.get(user, `/guilds/${guild.id}`)).body.channels.find((c) => c.id === channel.id).voice;

beforeEach(() => {
  calls.length = 0;
});

describe('voice channels', () => {
  it('says voice is available in /api/config', async () => {
    const res = await request(app).get('/api/config');
    expect(res.body.voiceEnabled).toBe(true);
  });

  it('gives members a token for the channel room, and nobody else', async () => {
    const { members: [alice], guild, general, lounge } = await setUp();
    const res = await join(alice, guild, lounge);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(process.env.LIVEKIT_URL);
    const claims = jwt.verify(res.body.token, process.env.LIVEKIT_API_SECRET);
    expect(claims.sub).toBe(String(alice.id));
    expect(claims.name).toBe(alice.username);
    expect(claims.video).toMatchObject({
      roomJoin: true, room: `channel-${lounge.id}`, canPublish: true, canSubscribe: true,
      canPublishData: false, canPublishSources: ['microphone', 'screen_share', 'screen_share_audio'],
    });

    expect((await join(alice, guild, general)).status).toBe(400);
    const outsider = await makeUser('outsider');
    expect((await join(outsider, guild, lounge)).status).toBe(404);
  });

  it('needs Connect, and without Speak only listens', async () => {
    const { owner, members: [alice], guild, lounge, gaming, everyone } = await setUp();
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.CONNECT });
    expect((await join(alice, guild, lounge)).status).toBe(403);

    await api.put(owner, `/guilds/${guild.id}/channels/${gaming.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.SPEAK });
    const res = await join(alice, guild, gaming);
    const { video } = jwt.decode(res.body.token);
    expect(video.canPublishSources).toEqual(['screen_share', 'screen_share_audio']);

    await api.put(owner, `/guilds/${guild.id}/channels/${gaming.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.SPEAK | P.STREAM });
    const listener = jwt.decode((await join(alice, guild, gaming)).body.token).video;
    expect(listener.canPublish).toBe(false);
    expect(listener.canPublishSources ?? []).toEqual([]);
  });

  it('shares screens only with Video', async () => {
    const { owner, members: [alice], guild, lounge, everyone } = await setUp();
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.STREAM });
    const { video } = jwt.decode((await join(alice, guild, lounge)).body.token);
    expect(video.canPublishSources).toEqual(['microphone']);
  });

  it('tells the channel who is sharing their screen, from the track webhooks', async () => {
    const { owner, members: [alice], guild, lounge } = await setUp();
    await join(alice, guild, lounge);
    const sid = await webhook('participant_joined', lounge, alice);
    const events = listen(owner);

    // Her microphone isn't a stream; another session's screen share isn't hers.
    await webhook('track_published', lounge, alice, sid, { sid: 'TR_mic', source: 'MICROPHONE', type: 'AUDIO' });
    await webhook('track_published', lounge, alice, 'PA_other', { sid: 'TR_x', source: 'SCREEN_SHARE', type: 'VIDEO' });
    expect(voiceEvents(events)).toEqual([]);

    await webhook('track_published', lounge, alice, sid, { sid: 'TR_screen', source: 'SCREEN_SHARE', type: 'VIDEO' });
    expect(voiceEvents(events).at(-1).state.self_stream).toBe(true);
    expect((await voiceOf(owner, guild, lounge))[0].self_stream).toBe(true);

    await webhook('track_unpublished', lounge, alice, sid, { sid: 'TR_screen', source: 'SCREEN_SHARE', type: 'VIDEO' });
    expect(voiceEvents(events).at(-1).state.self_stream).toBe(false);
    expect(voiceEvents(events)).toHaveLength(2);
  });

  it('rejects webhooks that LiveKit did not sign', async () => {
    const res = await request(app).post('/api/livekit/webhook')
      .set('Authorization', 'nonsense').set('Content-Type', 'application/webhook+json').send('{}');
    expect(res.status).toBe(401);
  });

  it('tracks who is in a channel from the webhooks and tells whoever can see it', async () => {
    const { owner, members: [alice], guild, lounge } = await setUp();
    const events = listen(owner);
    await join(alice, guild, lounge, { selfMute: true });
    const sid = await webhook('participant_joined', lounge, alice);

    const expected = { user_id: alice.id, username: alice.username, self_mute: true, self_deaf: false, self_stream: false };
    expect(await voiceOf(owner, guild, lounge)).toEqual([expected]);
    expect(voiceEvents(events)).toEqual([
      { type: 'guild_voice_state', guildId: guild.id, channelId: lounge.id, userId: alice.id, state: expected },
    ]);

    // Another session of hers leaving (a replaced device) doesn't take her out.
    await webhook('participant_left', lounge, alice, 'PA_other');
    expect(await voiceOf(owner, guild, lounge)).toHaveLength(1);

    await webhook('participant_left', lounge, alice, sid);
    expect(await voiceOf(owner, guild, lounge)).toEqual([]);
    expect(voiceEvents(events).at(-1).state).toBeNull();
  });

  it('keeps private channels private', async () => {
    const { owner, members: [alice, bob], guild, lounge, everyone } = await setUp(2);
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/member/${alice.id}`, { allow: P.VIEW_CHANNEL, deny: 0 });
    const bobEvents = listen(bob);
    await join(alice, guild, lounge);
    await webhook('participant_joined', lounge, alice);
    expect(voiceEvents(bobEvents)).toEqual([]);
    expect((await join(bob, guild, lounge)).status).toBe(404);
  });

  it('updates mute and deafen', async () => {
    const { owner, members: [alice], guild, lounge } = await setUp();
    // Before joining: remembered for when she does.
    expect((await api.put(alice, '/voice/state', { selfMute: false, selfDeaf: true })).body).toBeNull();
    await join(alice, guild, lounge, { selfMute: false, selfDeaf: true });
    await webhook('participant_joined', lounge, alice);
    expect((await voiceOf(owner, guild, lounge))[0].self_deaf).toBe(true);

    const events = listen(owner);
    const res = await api.put(alice, '/voice/state', { selfMute: true, selfDeaf: false });
    expect(res.body).toEqual({ guild_id: guild.id, channel_id: lounge.id, self_mute: true, self_deaf: false });
    expect(voiceEvents(events)[0].state).toMatchObject({ self_mute: true, self_deaf: false });
    expect(calls).toContainEqual(['update', `channel-${lounge.id}`, String(alice.id), { attributes: { selfMute: '1', selfDeaf: '' } }]);
    expect((await api.put(alice, '/voice/state', { selfMute: 'yes', selfDeaf: false })).status).toBe(400);
  });

  it('moves you out of your old channel when you join another', async () => {
    const { owner, members: [alice], guild, lounge, gaming } = await setUp();
    await join(alice, guild, lounge);
    await webhook('participant_joined', lounge, alice);
    await join(alice, guild, gaming);
    expect(calls).toContainEqual(['remove', `channel-${lounge.id}`, String(alice.id)]);
    expect(await voiceOf(owner, guild, lounge)).toEqual([]);
    await webhook('participant_joined', gaming, alice);
    expect((await voiceOf(owner, guild, gaming)).map((s) => s.user_id)).toEqual([alice.id]);
  });

  it('disconnects people who lose access, and takes Speak away live', async () => {
    const { owner, members: [alice, bob], guild, lounge, everyone } = await setUp(2);
    for (const user of [alice, bob]) {
      await join(user, guild, lounge);
      await webhook('participant_joined', lounge, user);
    }

    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/member/${bob.id}`, { allow: 0, deny: P.SPEAK });
    expect(calls).toContainEqual(['update', `channel-${lounge.id}`, String(bob.id), {
      permission: {
        canSubscribe: true, canPublish: true, canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
        canPublishData: false, canUpdateMetadata: false,
      },
    }]);
    calls.length = 0;
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/member/${bob.id}`, { allow: 0, deny: P.SPEAK | P.STREAM });
    expect(calls).toContainEqual(['update', `channel-${lounge.id}`, String(bob.id), {
      permission: { canSubscribe: true, canPublish: false, canPublishSources: [], canPublishData: false, canUpdateMetadata: false },
    }]);

    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.CONNECT });
    expect(calls).toContainEqual(['remove', `channel-${lounge.id}`, String(alice.id)]);
    expect(await voiceOf(owner, guild, lounge)).toEqual([]);
  });

  it('disconnects kicked members and everyone in a deleted channel', async () => {
    const { owner, members: [alice, bob], guild, lounge } = await setUp(2);
    for (const user of [alice, bob]) {
      await join(user, guild, lounge);
      await webhook('participant_joined', lounge, user);
    }
    await api.delete(owner, `/guilds/${guild.id}/members/${alice.id}`);
    expect(calls).toContainEqual(['remove', `channel-${lounge.id}`, String(alice.id)]);
    expect((await voiceOf(owner, guild, lounge)).map((s) => s.user_id)).toEqual([bob.id]);

    await api.delete(owner, `/guilds/${guild.id}/channels/${lounge.id}`);
    expect(calls).toContainEqual(['remove', `channel-${lounge.id}`, String(bob.id)]);
    expect(voice.states.has(bob.id)).toBe(false);
  });

  it('lets you leave', async () => {
    const { owner, members: [alice], guild, lounge } = await setUp();
    await join(alice, guild, lounge);
    await webhook('participant_joined', lounge, alice);
    expect((await api.delete(alice, '/voice')).status).toBe(200);
    expect(await voiceOf(owner, guild, lounge)).toEqual([]);
    expect(calls).toContainEqual(['remove', `channel-${lounge.id}`, String(alice.id)]);
  });

  it('gives new guilds Connect, Speak and Video for everyone', async () => {
    const { everyone } = await setUp(0);
    const voicePermissions = P.CONNECT | P.SPEAK | P.STREAM;
    expect(everyone.permissions & voicePermissions).toBe(voicePermissions);
  });
});
