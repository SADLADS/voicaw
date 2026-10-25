import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import { AccessToken } from 'livekit-server-sdk';
import { registerUser, loginUser } from './helpers/authFlow.js';
import { signedUploads, deletedObjects, objects, putMockObject } from './helpers/mockS3.js';

const app = require('../index.js');
const voice = require('../voice.js');
const soundboard = require('../soundboard.js');
const { PERMISSIONS: P, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');
const { toDiscordPermissions } = require('../discord.js');
const clients = app.locals.clients;

voice.livekit.roomService = { removeParticipant: async () => {}, updateParticipant: async () => {} };

let userCount = 0;
async function makeUser(prefix = 'sb-user') {
  const username = `${prefix}-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-sounds-123');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-sounds-123');
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};
const discord = {
  get: (bot, url) => request(app).get(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }),
  post: (bot, url, body = {}) => request(app).post(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }).send(body),
};

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}
const effects = (events) => events.filter((e) => e.type === 'guild_soundboard_play');

// Small files with the right first bytes.
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(100)]);

async function setUp(count = 2) {
  const owner = await makeUser('sb-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Sound Guild' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('sb-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  const lounge = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' })).body;
  const other = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Other', type: 'voice' })).body;
  return { owner, members, guild, lounge, other, everyone: guild.roles.find((r) => r.is_everyone) };
}

// Adds a sound the whole way (create, "upload", ready).
async function addSound(user, guildId, { name = 'Airhorn', emoji = '📯', volume = 0.8, file = MP3, type = 'audio/mpeg' } = {}) {
  const created = await api.post(user, `/guilds/${guildId}/soundboard`, { name, emoji, volume, type, size: file.length });
  expect(created.status).toBe(201);
  putMockObject('sounds', `src/${created.body.sound.id}`, file, type);
  return api.post(user, `/guilds/${guildId}/soundboard/${created.body.sound.id}/ready`);
}

// LiveKit's webhook saying `user` joined or left the channel's room.
let sidCount = 0;
async function webhook(event, channel, user, sid) {
  const body = JSON.stringify({
    event,
    id: `EV_${++sidCount}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { name: `channel-${channel.id}` },
    participant: { sid, identity: String(user.id), name: user.username },
  });
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  const res = await request(app).post('/api/livekit/webhook')
    .set('Authorization', await token.toJwt())
    .set('Content-Type', 'application/webhook+json')
    .send(body);
  expect(res.status).toBe(200);
}
const sids = new Map();
async function enter(user, channel) {
  const sid = `PA_${++sidCount}`;
  sids.set(user.id, sid);
  await webhook('participant_joined', channel, user, sid);
}
const leave = (user, channel) => webhook('participant_left', channel, user, sids.get(user.id));
const play = (user, guild, channel, soundId) => api.post(user, `/guilds/${guild.id}/channels/${channel.id}/soundboard/${soundId}`);

describe('soundboard', () => {
  it('gives @everyone Use Soundboard, which is Discord\'s bit 42 for bots', () => {
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.USE_SOUNDBOARD).toBe(P.USE_SOUNDBOARD);
    expect(BigInt(toDiscordPermissions(P.USE_SOUNDBOARD))).toBe(1n << 42n);
  });

  it('knows sounds by their first bytes', () => {
    expect(soundboard.sniffAudio(MP3)).toBe('audio/mpeg');
    expect(soundboard.sniffAudio(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('audio/mpeg');
    expect(soundboard.sniffAudio(WAV)).toBe('audio/wav');
    expect(soundboard.sniffAudio(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)]))).toBe('audio/ogg');
    expect(soundboard.sniffAudio(Buffer.from('<html><body>not a sound</body></html>'))).toBe(null);
  });

  it('lets Manage Emoji add a sound, which every member then sees', async () => {
    const { owner, members: [alice], guild } = await setUp(1);
    const events = listen(alice);
    const before = signedUploads.length;
    const ready = await addSound(owner, guild.id);
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ name: 'Airhorn', emoji: '📯', volume: 0.8, guild_id: guild.id });
    // Signed for exactly that size and type, in the sounds bucket.
    expect(signedUploads[before]).toMatchObject({ bucket: 'sounds', filename: `src/${ready.body.id}`, contentType: 'audio/mpeg', contentLength: MP3.length });
    // Stored under its id with the type its bytes say; the upload is gone.
    expect(objects.get(`sounds/${ready.body.id}`)).toMatchObject({ contentType: 'audio/mpeg' });
    expect(objects.has(`sounds/src/${ready.body.id}`)).toBe(false);

    const list = await api.get(alice, `/guilds/${guild.id}/soundboard`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ sounds: [{ id: ready.body.id, name: 'Airhorn' }], join_sound_id: null });
    const update = events.find((e) => e.type === 'guild_soundboard_update');
    expect(update).toMatchObject({ guildId: guild.id, sounds: [{ id: ready.body.id }], joinSoundId: null });

    const log = await api.get(owner, `/guilds/${guild.id}/audit-log`);
    expect(log.body.entries.find((e) => e.action === 'sound_create')).toMatchObject({ details: { name: 'Airhorn' } });
  });

  it('refuses members without Manage Emoji, and bad sounds', async () => {
    const { owner, members: [alice], guild } = await setUp(1);
    const outsider = await makeUser('sb-outsider');
    expect((await api.post(alice, `/guilds/${guild.id}/soundboard`, { name: 'Nope', type: 'audio/mpeg', size: 10 })).status).toBe(403);
    expect((await api.get(outsider, `/guilds/${guild.id}/soundboard`)).status).toBe(404);
    expect((await api.post(owner, `/guilds/${guild.id}/soundboard`, { name: 'x', type: 'audio/mpeg', size: 10 })).status).toBe(400);
    expect((await api.post(owner, `/guilds/${guild.id}/soundboard`, { name: 'Video', type: 'video/mp4', size: 10 })).status).toBe(400);
    expect((await api.post(owner, `/guilds/${guild.id}/soundboard`, { name: 'Huge', type: 'audio/mpeg', size: 600 * 1024 })).status).toBe(413);
    expect((await api.post(owner, `/guilds/${guild.id}/soundboard`, { name: 'Loud', type: 'audio/mpeg', size: 10, volume: 2 })).status).toBe(400);

    // Said to be an MP3, but isn't one: dropped.
    const fake = await addSound(owner, guild.id, { file: Buffer.from('<html>definitely not audio</html>') });
    expect(fake.status).toBe(400);
    expect((await api.get(owner, `/guilds/${guild.id}/soundboard`)).body.sounds).toEqual([]);
  });

  it('edits and deletes sounds; a deleted join sound is nobody\'s any more', async () => {
    const { owner, members: [alice], guild } = await setUp(1);
    const sound = (await addSound(owner, guild.id)).body;
    expect((await api.put(alice, `/guilds/${guild.id}/soundboard/join-sound`, { soundId: sound.id })).body).toEqual({ join_sound_id: sound.id });

    expect((await api.patch(alice, `/guilds/${guild.id}/soundboard/${sound.id}`, { name: 'Mine' })).status).toBe(403);
    const edited = await api.patch(owner, `/guilds/${guild.id}/soundboard/${sound.id}`, { name: 'Horn', emoji: null, volume: 0.5 });
    expect(edited.body).toMatchObject({ id: sound.id, name: 'Horn', emoji: null, volume: 0.5 });

    const events = listen(alice);
    expect((await api.delete(owner, `/guilds/${guild.id}/soundboard/${sound.id}`)).status).toBe(200);
    expect(deletedObjects).toContainEqual({ bucket: 'sounds', key: String(sound.id) });
    expect((await api.get(alice, `/guilds/${guild.id}/soundboard`)).body).toEqual({ sounds: [], join_sound_id: null });
    expect(events.find((e) => e.type === 'guild_soundboard_update')).toMatchObject({ sounds: [], joinSoundId: null });

    const actions = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body.entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['sound_update', 'sound_delete']));
  });

  it('plays a sound to everyone in the channel, and only them', async () => {
    const { owner, members: [alice, bob], guild, lounge, other } = await setUp(2);
    const sound = (await addSound(owner, guild.id)).body;
    expect((await play(alice, guild, lounge, sound.id)).status).toBe(400); // not in voice

    await enter(alice, lounge);
    await enter(owner, lounge);
    await enter(bob, other);
    const heard = { alice: listen(alice), owner: listen(owner), bob: listen(bob) };
    const res = await play(alice, guild, lounge, sound.id);
    expect(res.status).toBe(200);
    for (const who of ['alice', 'owner']) {
      expect(effects(heard[who])).toEqual([{
        type: 'guild_soundboard_play', guildId: guild.id, channelId: lounge.id, userId: alice.id, join: false,
        sound: { id: sound.id, guild_id: guild.id, name: 'Airhorn', emoji: '📯', volume: 0.8 },
      }]);
    }
    expect(effects(heard.bob)).toEqual([]);
    // Only in the channel you're in.
    expect((await play(alice, guild, other, sound.id)).status).toBe(400);

    // Not while deafened.
    await api.put(alice, '/voice/state', { selfMute: true, selfDeaf: true });
    expect((await play(alice, guild, lounge, sound.id)).status).toBe(400);
    await api.put(alice, '/voice/state', { selfMute: false, selfDeaf: false });
    await leave(alice, lounge);
    await leave(owner, lounge);
    await leave(bob, other);
  });

  it('needs Speak and Use Soundboard, and only plays the channel\'s guild\'s sounds', async () => {
    const { owner, members: [alice], guild, lounge, everyone } = await setUp(1);
    const sound = (await addSound(owner, guild.id)).body;
    const elsewhere = await setUp(0);
    const foreign = (await addSound(elsewhere.owner, elsewhere.guild.id)).body;
    await enter(alice, lounge);
    expect((await play(alice, guild, lounge, foreign.id)).status).toBe(404);

    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.USE_SOUNDBOARD });
    expect((await play(alice, guild, lounge, sound.id)).status).toBe(403);
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.SPEAK });
    expect((await play(alice, guild, lounge, sound.id)).status).toBe(403);
    await leave(alice, lounge);
  });

  it('plays your join sound when you join, not again when you come straight back', async () => {
    const { owner, members: [alice], guild, lounge, other, everyone } = await setUp(1);
    const sound = (await addSound(owner, guild.id, { name: 'Hello' })).body;
    const elsewhere = await setUp(0);
    const foreign = (await addSound(elsewhere.owner, elsewhere.guild.id)).body;
    expect((await api.put(alice, `/guilds/${guild.id}/soundboard/join-sound`, { soundId: foreign.id })).status).toBe(404);
    expect((await api.put(alice, `/guilds/${guild.id}/soundboard/join-sound`, { soundId: 'x' })).status).toBe(400);

    const aliceEvents = listen(alice);
    expect((await api.put(alice, `/guilds/${guild.id}/soundboard/join-sound`, { soundId: sound.id })).status).toBe(200);
    expect(aliceEvents.find((e) => e.type === 'guild_join_sound')).toEqual({ type: 'guild_join_sound', guildId: guild.id, soundId: sound.id });

    await enter(owner, lounge);
    const ownerEvents = listen(owner);
    await enter(alice, lounge);
    for (const events of [ownerEvents, aliceEvents]) {
      expect(effects(events)).toEqual([expect.objectContaining({ userId: alice.id, channelId: lounge.id, join: true, sound: expect.objectContaining({ id: sound.id }) })]);
    }
    // A dropped connection rejoining: not again.
    await leave(alice, lounge);
    await enter(alice, lounge);
    expect(effects(ownerEvents)).toHaveLength(1);

    // Not where Use Soundboard is taken away.
    await api.put(owner, `/guilds/${guild.id}/channels/${other.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.USE_SOUNDBOARD });
    await enter(alice, other);
    expect(effects(aliceEvents)).toHaveLength(1);
    await leave(alice, other);
    await leave(owner, lounge);
  });

  it('deletes a guild\'s sounds with it', async () => {
    const { owner, guild } = await setUp(0);
    const sound = (await addSound(owner, guild.id)).body;
    expect((await api.delete(owner, `/guilds/${guild.id}`)).status).toBe(200);
    expect(deletedObjects).toContainEqual({ bucket: 'sounds', key: String(sound.id) });
  });

  it('gives bots Discord\'s soundboard API', async () => {
    const { owner, guild, lounge } = await setUp(0);
    const sound = (await addSound(owner, guild.id)).body;
    const created = await api.post(owner, '/applications', { name: 'Horns' });
    const bot = { id: created.body.id, token: created.body.token };
    await api.post(owner, '/oauth2/authorize', {
      client_id: bot.id, guild_id: guild.id,
      permissions: toDiscordPermissions(P.VIEW_CHANNEL | P.CONNECT | P.SPEAK | P.USE_SOUNDBOARD | P.MANAGE_EMOJIS),
    });

    const list = await discord.get(bot, `/guilds/${guild.id}/soundboard-sounds`);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([expect.objectContaining({
      name: 'Airhorn', sound_id: String(sound.id), volume: 0.8, emoji_id: null, emoji_name: '📯', guild_id: String(guild.id), available: true,
    })]);
    expect((await discord.get(bot, `/guilds/${guild.id}/soundboard-sounds/999999`)).status).toBe(404);
    expect((await discord.get(bot, '/soundboard-default-sounds')).body).toEqual([]);

    const made = await discord.post(bot, `/guilds/${guild.id}/soundboard-sounds`, {
      name: 'Beep', volume: 1, emoji_name: '🤖', sound: `data:audio/wav;base64,${WAV.toString('base64')}`,
    });
    expect(made.status).toBe(201);
    expect(objects.get(`sounds/${made.body.sound_id}`)).toMatchObject({ contentType: 'audio/wav' });

    expect((await discord.post(bot, `/channels/${lounge.id}/send-soundboard-sound`, { sound_id: String(sound.id) })).status).toBe(400);
    await enter({ id: bot.id, username: 'Horns' }, lounge);
    await enter(owner, lounge);
    const events = listen(owner);
    expect((await discord.post(bot, `/channels/${lounge.id}/send-soundboard-sound`, { sound_id: String(sound.id) })).status).toBe(204);
    expect(effects(events)).toEqual([expect.objectContaining({ userId: bot.id, sound: expect.objectContaining({ id: sound.id }) })]);

    const cdn = await request(app).get(`/api/cdn/soundboard-sounds/${sound.id}`);
    expect(cdn.status).toBe(302);
    expect(cdn.headers.location).toBe(`${process.env.S3_ENDPOINT}/sounds/${sound.id}`);
    await leave({ id: bot.id }, lounge);
    await leave(owner, lounge);
  });
});
