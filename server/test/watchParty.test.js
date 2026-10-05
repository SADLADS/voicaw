import './helpers/mockS3.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import { AccessToken } from 'livekit-server-sdk';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const voice = require('../voice.js');
const watchParty = require('../watchParty.js');
const { PERMISSIONS: P, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');
const clients = app.locals.clients;

voice.livekit.roomService = { removeParticipant: async () => {}, updateParticipant: async () => {} };

// YouTube isn't asked: these ids exist, 'private0000' can't be embedded, 'missing0000' is gone.
const asked = [];
watchParty.youtube.videoInfo = async (videoId) => {
  asked.push(videoId);
  if (videoId === 'private0000') throw Object.assign(new Error("This video can't be played outside YouTube"), { status: 400 });
  if (videoId === 'missing0000') throw Object.assign(new Error('Video not found'), { status: 400 });
  return { title: `Video ${videoId}`, author: 'Someone' };
};
const VIDEO_A = 'aaaaaaaaaaa';
const VIDEO_B = 'bbbbbbbbbbb';
const VIDEO_C = 'ccccccccccc';

let userCount = 0;
async function makeUser(prefix = 'wp-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-watch-123';
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
const partyEvents = (events) => events.filter((e) => e.type === 'guild_watch_party');

async function setUp(count = 2) {
  const owner = await makeUser('owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Watch Guild' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  const lounge = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' })).body;
  const base = `/guilds/${guild.id}/channels/${lounge.id}/watch-party`;
  return { owner, members, guild, general: guild.channels[0], lounge, base, everyone: guild.roles.find((r) => r.is_everyone) };
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

const add = (user, base, videoId) => api.post(user, `${base}/queue`, { videoId });

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  asked.length = 0;
});

describe('Watch Together', () => {
  it('gives @everyone Queue Videos and Control Playback, not Manage Queue', () => {
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.QUEUE_VIDEOS).toBe(P.QUEUE_VIDEOS);
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.CONTROL_PLAYBACK).toBe(P.CONTROL_PLAYBACK);
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.MANAGE_QUEUE).toBe(0);
  });

  it('shows the party to whoever can see the channel, and nobody else', async () => {
    const { members: [alice], base, general, guild } = await setUp(1);
    const res = await api.get(alice, base);
    expect(res.status).toBe(200);
    expect(res.body.party).toBeNull();
    expect(res.body.server_time).toBeTypeOf('number');

    const outsider = await makeUser('outsider');
    expect((await api.get(outsider, base)).status).toBe(404);
    expect((await api.get(alice, `/guilds/${guild.id}/channels/${general.id}/watch-party`)).status).toBe(400);
  });

  it('needs you in the voice channel to add videos', async () => {
    const { members: [alice], base, lounge } = await setUp(1);
    expect((await add(alice, base, VIDEO_A)).status).toBe(403);
    await enter(alice, lounge);
    expect((await add(alice, base, 'not an id')).status).toBe(400);
    expect((await add(alice, base, 'private0000')).body.error).toMatch(/outside YouTube/);
    expect((await add(alice, base, 'missing0000')).status).toBe(400);
  });

  it('plays the first video at once and queues the rest, telling the channel', async () => {
    const { owner, members: [alice, bob], base, lounge, guild } = await setUp();
    const bobEvents = listen(bob);
    await enter(alice, lounge);

    const before = Date.now();
    const first = await add(alice, base, VIDEO_A);
    expect(first.status).toBe(200);
    expect(first.body.party).toMatchObject({
      current: { video_id: VIDEO_A, title: `Video ${VIDEO_A}`, author: 'Someone', duration: null, added_by: alice.id },
      queue: [],
      playing: true,
      position: 0,
    });
    expect(first.body.party.updated_at).toBeGreaterThanOrEqual(before);

    const second = await add(alice, base, VIDEO_B);
    expect(second.body.party.current.video_id).toBe(VIDEO_A);
    expect(second.body.party.queue.map((i) => i.video_id)).toEqual([VIDEO_B]);

    // Bob isn't in voice, but sees it (the channel page and list).
    const events = partyEvents(bobEvents);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ guildId: guild.id, channelId: lounge.id, party: { queue: [{ video_id: VIDEO_B }] } });
    const layout = (await api.get(owner, `/guilds/${guild.id}`)).body;
    expect(layout.channels.find((c) => c.id === lounge.id).watch_party).toEqual({ video_id: VIDEO_A, title: `Video ${VIDEO_A}`, playing: true });
    expect((await api.get(bob, base)).body.party.queue).toHaveLength(1);
  });

  it('follows Queue Videos', async () => {
    const { owner, members: [alice], base, lounge, guild, everyone } = await setUp(1);
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.QUEUE_VIDEOS });
    await enter(alice, lounge);
    expect((await add(alice, base, VIDEO_A)).status).toBe(403);
    expect(asked).toEqual([]);
  });

  it('lets people remove their own videos, and anyone\'s with Manage Queue', async () => {
    const { owner, members: [alice, bob], base, lounge } = await setUp();
    for (const user of [owner, alice, bob]) await enter(user, lounge);
    await add(alice, base, VIDEO_A);
    const { party } = (await add(alice, base, VIDEO_B)).body;
    const alicesQueued = party.queue[0].id;
    const bobsQueued = (await add(bob, base, VIDEO_C)).body.party.queue[1].id;

    expect((await api.delete(alice, `${base}/queue/${bobsQueued}`)).status).toBe(403);
    expect((await api.delete(alice, `${base}/queue/${alicesQueued}`)).body.party.queue.map((i) => i.id)).toEqual([bobsQueued]);
    expect((await api.delete(owner, `${base}/queue/${bobsQueued}`)).body.party.queue).toEqual([]);
    expect((await api.delete(owner, `${base}/queue/${bobsQueued}`)).status).toBe(404);
    // The one playing isn't in the queue: that's skipping.
    expect((await api.delete(owner, `${base}/queue/${party.current.id}`)).status).toBe(404);
  });

  it('reorders the queue with Manage Queue', async () => {
    const { owner, members: [alice], base, lounge, guild, everyone } = await setUp(1);
    for (const user of [owner, alice]) await enter(user, lounge);
    await add(alice, base, VIDEO_A);
    await add(alice, base, VIDEO_B);
    const { queue } = (await add(alice, base, VIDEO_C)).body.party;
    const [b, c] = queue.map((i) => i.id);

    expect((await api.put(alice, `${base}/queue/${c}/move`, { beforeId: b })).status).toBe(403);
    const moved = await api.put(owner, `${base}/queue/${c}/move`, { beforeId: b });
    expect(moved.body.party.queue.map((i) => i.id)).toEqual([c, b]);
    const toEnd = await api.put(owner, `${base}/queue/${c}/move`, { beforeId: null });
    expect(toEnd.body.party.queue.map((i) => i.id)).toEqual([b, c]);
    expect((await api.put(owner, `${base}/queue/${c}/move`, { beforeId: 'b' })).status).toBe(400);
    expect((await api.put(owner, `${base}/queue/${c}/move`, { beforeId: 999999 })).status).toBe(404);

    // Given to a role (here @everyone, in this channel), it works for its members.
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: P.MANAGE_QUEUE, deny: 0 });
    expect((await api.put(alice, `${base}/queue/${c}/move`, { beforeId: b })).status).toBe(200);
  });

  it('plays, pauses and seeks with Control Playback', async () => {
    const { owner, members: [alice], base, lounge, guild, everyone } = await setUp(1);
    await enter(alice, lounge);
    const { party } = (await add(alice, base, VIDEO_A)).body;

    const paused = await api.put(alice, `${base}/playback`, { playing: false, position: 42.5, itemId: party.current.id });
    expect(paused.body.party).toMatchObject({ playing: false, position: 42.5 });
    const resumed = await api.put(alice, `${base}/playback`, { playing: true });
    expect(resumed.body.party).toMatchObject({ playing: true, position: 42.5 });

    expect((await api.put(alice, `${base}/playback`, {})).status).toBe(400);
    expect((await api.put(alice, `${base}/playback`, { position: -1 })).status).toBe(400);
    expect((await api.put(alice, `${base}/playback`, { playing: 'yes' })).status).toBe(400);
    expect((await api.put(alice, `${base}/playback`, { playing: false, itemId: party.current.id + 1 })).status).toBe(409);

    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.CONTROL_PLAYBACK });
    expect((await api.put(alice, `${base}/playback`, { playing: false })).status).toBe(403);
  });

  it('skips to the next video, and ends with the last', async () => {
    const { owner, members: [alice, bob], base, lounge, guild, everyone } = await setUp();
    for (const user of [alice, bob]) await enter(user, lounge);
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.CONTROL_PLAYBACK });
    const first = (await add(alice, base, VIDEO_A)).body.party.current;
    const second = (await add(bob, base, VIDEO_B)).body.party.queue[0];

    // Without Control Playback, only whoever added the video playing may skip it.
    expect((await api.post(bob, `${base}/skip`, { itemId: first.id })).status).toBe(403);
    const skipped = await api.post(alice, `${base}/skip`, { itemId: first.id });
    expect(skipped.body.party).toMatchObject({ current: { id: second.id }, queue: [], playing: true, position: 0 });
    // A second skip of the same video does nothing.
    expect((await api.post(bob, `${base}/skip`, { itemId: first.id })).body.party.current.id).toBe(second.id);

    const ended = await api.post(bob, `${base}/skip`, { itemId: second.id });
    expect(ended.body.party).toBeNull();
    expect((await api.post(bob, `${base}/skip`, { itemId: second.id })).status).toBe(404);
  });

  it('moves on by itself when a video ends, once a player said how long it is', async () => {
    const { members: [alice], base, lounge } = await setUp(1);
    await enter(alice, lounge);
    await add(alice, base, VIDEO_A);
    const { party } = (await add(alice, base, VIDEO_B)).body;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    expect((await api.put(alice, `${base}/duration`, { itemId: party.current.id, duration: 30 })).status).toBe(200);
    // The first answer counts.
    await api.put(alice, `${base}/duration`, { itemId: party.current.id, duration: 5 });
    expect(watchParty.getParty(lounge.id).current.duration).toBe(30);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(watchParty.getParty(lounge.id).current.videoId).toBe(VIDEO_A);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(watchParty.getParty(lounge.id).current.videoId).toBe(VIDEO_B);

    // Paused, it doesn't end.
    const next = watchParty.getParty(lounge.id).current;
    await watchParty.setDuration(watchParty.getParty(lounge.id), next.id, 10);
    await watchParty.setPlayback(watchParty.getParty(lounge.id), { playing: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watchParty.getParty(lounge.id).current.id).toBe(next.id);
  });

  it('ends a minute after the channel empties, unless someone comes back', async () => {
    const { members: [alice, bob], base, lounge } = await setUp();
    const bobEvents = listen(bob);
    await enter(alice, lounge);
    await add(alice, base, VIDEO_A);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await leave(alice, lounge);
    await vi.advanceTimersByTimeAsync(watchParty.EMPTY_GRACE_MS / 2);
    await enter(alice, lounge);
    await vi.advanceTimersByTimeAsync(watchParty.EMPTY_GRACE_MS);
    expect(watchParty.getParty(lounge.id)).not.toBeNull();

    await leave(alice, lounge);
    await vi.advanceTimersByTimeAsync(watchParty.EMPTY_GRACE_MS + 1);
    expect(watchParty.getParty(lounge.id)).toBeNull();
    expect(partyEvents(bobEvents).at(-1).party).toBeNull();
  });

  it('goes with its channel', async () => {
    const { owner, members: [alice], base, lounge, guild } = await setUp(1);
    await enter(alice, lounge);
    await add(alice, base, VIDEO_A);
    expect((await api.delete(owner, `/guilds/${guild.id}/channels/${lounge.id}`)).status).toBe(200);
    expect(watchParty.getParty(lounge.id)).toBeNull();
  });
  it('logs who did what, for everyone who can see the channel', async () => {
    const { owner, members: [alice, bob], base, lounge } = await setUp();
    const bobEvents = listen(bob);
    for (const user of [owner, alice]) await enter(user, lounge);
    const first = (await add(alice, base, VIDEO_A)).body.party.current;
    await add(alice, base, VIDEO_B);
    const third = (await add(owner, base, VIDEO_C)).body.party.queue[1];
    await api.put(owner, `${base}/queue/${third.id}/move`, { beforeId: null });
    await api.put(owner, `${base}/queue/${third.id}/move`, { beforeId: (await api.get(owner, base)).body.party.queue[0].id });
    await api.put(alice, `${base}/playback`, { playing: false });
    await api.put(alice, `${base}/playback`, { playing: false }); // nothing changed: not logged
    await api.put(owner, `${base}/playback`, { position: 90 });
    await api.put(owner, `${base}/playback`, { playing: true });
    await api.delete(owner, `${base}/queue/${third.id}`);
    await api.post(alice, `${base}/skip`, { itemId: first.id });

    const { log } = (await api.get(bob, base)).body;
    expect(log.map((e) => [e.action, e.user_id, e.video_id])).toEqual([
      ['add', alice.id, VIDEO_A],
      ['add', alice.id, VIDEO_B],
      ['add', owner.id, VIDEO_C],
      ['move', owner.id, VIDEO_C],
      ['move', owner.id, VIDEO_C],
      ['pause', alice.id, VIDEO_A],
      ['seek', owner.id, VIDEO_A],
      ['play', owner.id, VIDEO_A],
      ['remove', owner.id, VIDEO_C],
      ['skip', alice.id, VIDEO_A],
    ]);
    expect(log[0]).toMatchObject({ title: `Video ${VIDEO_A}` });
    expect(log[0].at).toBeTypeOf('number');
    expect(log[4]).toMatchObject({ to: 1 });
    expect(log[6]).toMatchObject({ from: 0, to: 90 });

    // Each event carries its new entry; Bob (not in voice) got them all.
    const entries = partyEvents(bobEvents).map((e) => e.entry).filter(Boolean);
    expect(entries.map((e) => e.id)).toEqual(log.map((e) => e.id));

    const outsider = await makeUser('outsider');
    expect((await api.get(outsider, base)).status).toBe(404);
  });

  it('logs the server moving on by itself, and keeps the log after the party ends', async () => {
    const { members: [alice], base, lounge } = await setUp(1);
    await enter(alice, lounge);
    const { party } = (await add(alice, base, VIDEO_A)).body;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await api.put(alice, `${base}/duration`, { itemId: party.current.id, duration: 5 });
    await vi.advanceTimersByTimeAsync(7_000);
    const res = await api.get(alice, base);
    expect(res.body.party).toBeNull();
    expect(res.body.log.map((e) => [e.action, e.user_id])).toEqual([['add', alice.id], ['ended', null]]);

    // Forgotten a minute after the channel empties.
    await leave(alice, lounge);
    await vi.advanceTimersByTimeAsync(watchParty.EMPTY_GRACE_MS + 1);
    expect(watchParty.logOf(lounge.id)).toEqual([]);
  });

  it('keeps the last 100 entries', async () => {
    const { members: [alice], base, lounge } = await setUp(1);
    await enter(alice, lounge);
    await add(alice, base, VIDEO_A);
    for (let i = 0; i < 105; i++) await watchParty.setPlayback(watchParty.getParty(lounge.id), { playing: i % 2 === 0 }, alice.id);
    const { log } = (await api.get(alice, base)).body;
    expect(log).toHaveLength(100);
    expect(log.at(-1).action).toBe('play'); // the last call (i = 104) plays
    expect(log[0].action).toBe('pause'); // the add and the oldest went
  });
});
