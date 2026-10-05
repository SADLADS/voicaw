import './helpers/mockS3.js';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { AccessToken } from 'livekit-server-sdk';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const voice = require('../voice.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { toDiscordPermissions } = require('../discord.js');

// LiveKit itself isn't there: this records what the API asks of it.
const calls = [];
voice.livekit.roomService = {
  removeParticipant: async (room, identity) => { calls.push(['remove', room, identity]); },
  updateParticipant: async (room, identity, options) => { calls.push(['update', room, identity, options]); },
};
beforeEach(() => { calls.length = 0; });

let userCount = 0;
async function makeUser(prefix = 'bv-user') {
  const username = `${prefix}-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-bot-voice-1');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-bot-voice-1');
  return { id: regRes.body.id, username, token: loginRes.body.token };
}
const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};
const discord = {
  get: (bot, url) => request(app).get(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }),
  post: (bot, url, body = {}) => request(app).post(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }).send(body),
  patch: (bot, url, body = {}) => request(app).patch(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }).send(body),
  delete: (bot, url) => request(app).delete(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }),
};

// A webhook as LiveKit sends it (signed, with the body's hash).
let sidCount = 0;
async function webhook(event, channel, userId, name) {
  const body = JSON.stringify({
    event,
    id: `EV_${++sidCount}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { name: `channel-${channel.id}` },
    participant: { sid: `PA_${sidCount}`, identity: String(userId), name },
  });
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  await request(app).post('/api/livekit/webhook').set('Authorization', await token.toJwt())
    .set('Content-Type', 'application/webhook+json').send(body);
}

// A guild with a voice channel, and a bot added with `permissions` (ours).
async function setUp(permissions) {
  const owner = await makeUser('bv-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Voice Bots' })).body;
  const lounge = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' })).body;
  const created = await api.post(owner, '/applications', { name: 'Radio' });
  const bot = { id: created.body.id, token: created.body.token };
  await api.post(owner, '/oauth2/authorize', { client_id: bot.id, guild_id: guild.id, permissions: toDiscordPermissions(permissions) });
  return { owner, guild, lounge, bot, general: guild.channels[0] };
}

describe('bots in voice', () => {
  it('get a LiveKit token: Speak to send audio, Listen to hear, each only if given', async () => {
    const speaker = await setUp(P.VIEW_CHANNEL | P.CONNECT | P.SPEAK);
    const res = await discord.post(speaker.bot, `/channels/${speaker.lounge.id}/voice`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: process.env.LIVEKIT_URL, room: `channel-${speaker.lounge.id}`, identity: String(speaker.bot.id), speak: true, listen: false });
    const grant = jwt.verify(res.body.token, process.env.LIVEKIT_API_SECRET);
    expect(grant.sub).toBe(String(speaker.bot.id));
    expect(grant.name).toBe('Radio');
    expect(grant.video).toMatchObject({ roomJoin: true, canPublish: true, canPublishSources: ['microphone'], canSubscribe: false });
    // @everyone's Listen (people's default), even allowed in the channel, never counts for a bot.
    const everyone = (await api.get(speaker.owner, `/guilds/${speaker.guild.id}`)).body.roles.find((r) => r.is_everyone);
    expect(everyone.permissions & P.LISTEN).toBe(P.LISTEN);
    await api.put(speaker.owner, `/guilds/${speaker.guild.id}/channels/${speaker.lounge.id}/overrides/role/${everyone.id}`, { allow: P.LISTEN, deny: 0 });
    expect((await discord.post(speaker.bot, `/channels/${speaker.lounge.id}/voice`)).body.listen).toBe(false);

    const listener = await setUp(P.VIEW_CHANNEL | P.CONNECT | P.LISTEN);
    const heard = jwt.decode((await discord.post(listener.bot, `/channels/${listener.lounge.id}/voice`)).body.token).video;
    expect(heard.canSubscribe).toBe(true); // (it also speaks: Speak comes from @everyone, as in Discord)

    // Without Connect, or in a text channel: no.
    const outside = await setUp(P.VIEW_CHANNEL);
    const outsideRole = (await api.get(outside.owner, `/guilds/${outside.guild.id}`)).body.roles.find((r) => r.bot_id === outside.bot.id);
    await api.put(outside.owner, `/guilds/${outside.guild.id}/channels/${outside.lounge.id}/overrides/role/${outsideRole.id}`, { allow: 0, deny: P.CONNECT });
    expect((await discord.post(outside.bot, `/channels/${outside.lounge.id}/voice`)).body).toMatchObject({ code: 50013 });
    expect((await discord.post(speaker.bot, `/channels/${speaker.general.id}/voice`)).body).toMatchObject({ code: 50024 });
  });

  it('shows the bot in the channel, listening or not, and lets it mute, change its mind and leave', async () => {
    const { owner, guild, lounge, bot } = await setUp(P.VIEW_CHANNEL | P.CONNECT | P.SPEAK);
    await discord.post(bot, `/channels/${lounge.id}/voice`);
    await webhook('participant_joined', lounge, bot.id, 'Radio');
    const inChannel = (await api.get(owner, `/guilds/${guild.id}`)).body.channels.find((c) => c.id === lounge.id).voice;
    expect(inChannel).toEqual([expect.objectContaining({ user_id: bot.id, listening: false })]);

    const mine = await discord.get(bot, `/guilds/${guild.id}/voice-states/@me`);
    expect(mine.body).toMatchObject({ channel_id: String(lounge.id), user_id: String(bot.id), self_mute: false, listening: false });
    expect((await discord.patch(bot, `/guilds/${guild.id}/voice-states/@me`, { self_mute: true })).status).toBe(204);
    expect((await discord.get(bot, `/guilds/${guild.id}/voice-states/@me`)).body.self_mute).toBe(true);

    // The owner lets it listen: LiveKit is told at once.
    const role = (await api.get(owner, `/guilds/${guild.id}`)).body.roles.find((r) => r.bot_id === bot.id);
    await request(app).patch(`/api/guilds/${guild.id}/roles/${role.id}`).set(authed(owner)).send({ permissions: role.permissions | P.LISTEN });
    expect(calls).toContainEqual(['update', `channel-${lounge.id}`, String(bot.id), { permission: expect.objectContaining({ canSubscribe: true }) }]);
    expect((await discord.get(bot, `/guilds/${guild.id}/voice-states/@me`)).body.listening).toBe(true);

    expect((await discord.delete(bot, `/guilds/${guild.id}/voice-states/@me`)).status).toBe(204);
    expect(calls).toContainEqual(['remove', `channel-${lounge.id}`, String(bot.id)]);
    expect((await discord.get(bot, `/guilds/${guild.id}/voice-states/@me`)).body).toMatchObject({ code: 10065 });
  });
});
