import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHash, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { AccessToken } from 'livekit-server-sdk';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const voice = require('../voice.js');
const calls = require('../calls.js');
const clients = app.locals.clients;

// LiveKit itself isn't there: this records what the API asks of it.
const liveKitCalls = [];
const fakeRoomService = {
  removeParticipant: async (room, identity) => { liveKitCalls.push(['remove', room, identity]); },
  updateParticipant: async () => {},
  deleteRoom: async (room) => { liveKitCalls.push(['deleteRoom', room]); },
  listParticipants: async () => [],
};

let userCount = 0;
async function makeUser(prefix = 'caller') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-calls-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}
const ofType = (events, type) => events.filter((e) => e.type === type);

const ENVELOPE = `v1.${'A'.repeat(100)}`;
const ring = (caller, callee, callId = randomUUID()) =>
  api.post(caller, '/dm-calls', { calleeId: callee.id, callId, keyEnvelope: ENVELOPE });

async function webhook(event, room, user) {
  const body = JSON.stringify({
    event,
    id: `EV_${randomUUID()}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { name: room },
    participant: user && { sid: `PA_${randomUUID()}`, identity: String(user.id), name: user.username },
  });
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  const res = await request(app).post('/api/livekit/webhook')
    .set('Authorization', await token.toJwt()).set('Content-Type', 'application/webhook+json').send(body);
  expect(res.status).toBe(200);
}

beforeEach(() => {
  liveKitCalls.length = 0;
  voice.livekit.roomService = fakeRoomService;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const call of [...calls.calls.values()]) await calls.endCall(call, 'ended');
});

describe('DM calls', () => {
  it('rings the other person with the encrypted key, and gives the caller a token', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const bobEvents = listen(bob);
    const aliceEvents = listen(alice);
    const callId = randomUUID();
    const res = await ring(alice, bob, callId);
    expect(res.status).toBe(201);
    expect(res.body.call).toMatchObject({
      id: callId, caller_id: alice.id, caller_username: alice.username, callee_id: bob.id,
      state: 'ringing', key_envelope: ENVELOPE,
    });
    const claims = jwt.verify(res.body.token, process.env.LIVEKIT_API_SECRET);
    expect(claims.sub).toBe(String(alice.id));
    expect(claims.video).toMatchObject({ room: `call-${callId}`, canPublish: true, canPublishSources: ['microphone'] });

    expect(ofType(bobEvents, 'call_incoming')[0].call).toEqual({ ...res.body.call, server_now: expect.any(Number) });
    expect(ofType(aliceEvents, 'call_update')[0].call.id).toBe(callId);
    expect((await api.get(bob, '/dm-calls/current')).body.id).toBe(callId);
    expect((await api.get(alice, '/dm-calls/current')).body.id).toBe(callId);
  });

  it('pushes the ring, and a missed call if nobody answers', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    await request(app).post('/api/save-subscription').set(authed(bob))
      .send({ subscription: { endpoint: `https://push.test/${bob.id}`, keys: { p256dh: 'p', auth: 'a' } } });
    const since = sentPushes.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const callId = randomUUID();
    await ring(alice, bob, callId);
    vi.useRealTimers();
    const [push] = await waitForPushes(1, since);
    expect(push.payload).toMatchObject({ type: 'call', title: alice.username, body: 'Incoming voice call', url: `/dm/${alice.id}`, tag: `call-${callId}` });

    const bobEvents = listen(bob);
    await calls.endCall(calls.calls.get(callId), 'missed');
    const pushes = await waitForPushes(2, since);
    expect(pushes[1].payload).toMatchObject({ body: 'Missed call', tag: `call-${callId}` });
    expect(ofType(bobEvents, 'call_end')).toEqual([{ type: 'call_end', id: callId, reason: 'missed' }]);
    expect(liveKitCalls).toContainEqual(['deleteRoom', `call-${callId}`]);
  });

  it('stops ringing after a while', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const [alice, bob] = [await makeUser(), await makeUser()];
    const callId = randomUUID();
    await ring(alice, bob, callId);
    const aliceEvents = listen(alice);
    await vi.advanceTimersByTimeAsync(calls.RING_MS + 10);
    expect(ofType(aliceEvents, 'call_end')[0]).toMatchObject({ id: callId, reason: 'missed' });
    expect(calls.calls.has(callId)).toBe(false);
  });

  it('lets the person called answer, once', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const callId = (await ring(alice, bob)).body.call.id;
    expect((await api.post(alice, `/dm-calls/${callId}/accept`)).status).toBe(403);
    const aliceEvents = listen(alice);
    const res = await api.post(bob, `/dm-calls/${callId}/accept`);
    expect(res.status).toBe(200);
    expect(res.body.call.state).toBe('active');
    expect(jwt.decode(res.body.token)).toMatchObject({ sub: String(bob.id), video: { room: `call-${callId}` } });
    expect(ofType(aliceEvents, 'call_update')[0].call.state).toBe('active');
    expect((await api.post(bob, `/dm-calls/${callId}/accept`)).status).toBe(409);
  });

  it('declines, hangs up and cancels, telling both', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const aliceEvents = listen(alice);

    let callId = (await ring(alice, bob)).body.call.id;
    await api.post(bob, `/dm-calls/${callId}/decline`);
    expect(ofType(aliceEvents, 'call_end').at(-1)).toMatchObject({ id: callId, reason: 'declined' });

    callId = (await ring(alice, bob)).body.call.id;
    await api.delete(alice, `/dm-calls/${callId}`);
    expect(ofType(aliceEvents, 'call_end').at(-1)).toMatchObject({ id: callId, reason: 'cancelled' });

    callId = (await ring(alice, bob)).body.call.id;
    await api.post(bob, `/dm-calls/${callId}/accept`);
    await api.delete(bob, `/dm-calls/${callId}`);
    expect(ofType(aliceEvents, 'call_end').at(-1)).toMatchObject({ id: callId, reason: 'ended' });
    expect((await api.get(alice, '/dm-calls/current')).body).toBeNull();
  });

  it('keeps outsiders out and checks what it is given', async () => {
    const [alice, bob, eve] = [await makeUser(), await makeUser(), await makeUser('eve')];
    const callId = (await ring(alice, bob)).body.call.id;
    expect((await api.post(eve, `/dm-calls/${callId}/accept`)).status).toBe(404);
    expect((await api.delete(eve, `/dm-calls/${callId}`)).status).toBe(404);
    expect((await api.get(eve, '/dm-calls/current')).body).toBeNull();

    expect((await api.post(eve, '/dm-calls', { calleeId: eve.id, callId: randomUUID(), keyEnvelope: ENVELOPE })).status).toBe(404);
    expect((await api.post(eve, '/dm-calls', { calleeId: 999999, callId: randomUUID(), keyEnvelope: ENVELOPE })).status).toBe(404);
    expect((await api.post(eve, '/dm-calls', { calleeId: bob.id, callId: 'x', keyEnvelope: ENVELOPE })).status).toBe(400);
    expect((await api.post(eve, '/dm-calls', { calleeId: bob.id, callId: randomUUID(), keyEnvelope: 'plain key' })).status).toBe(400);
    // Bob is busy.
    const busy = await api.post(eve, '/dm-calls', { calleeId: bob.id, callId: randomUUID(), keyEnvelope: ENVELOPE });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe(`${bob.username} is in another call`);
  });

  it('ends when someone leaves the LiveKit room', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const callId = (await ring(alice, bob)).body.call.id;
    await api.post(bob, `/dm-calls/${callId}/accept`);
    const aliceEvents = listen(alice);
    // Still in the room after the grace period: nothing happens.
    fakeRoomService.listParticipants = async () => [{ identity: String(bob.id) }];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await webhook('participant_left', `call-${callId}`, bob);
    await vi.advanceTimersByTimeAsync(11000);
    expect(calls.calls.has(callId)).toBe(true);
    // Gone for good.
    fakeRoomService.listParticipants = async () => [];
    await webhook('participant_left', `call-${callId}`, bob);
    await vi.advanceTimersByTimeAsync(11000);
    expect(ofType(aliceEvents, 'call_end')).toEqual([{ type: 'call_end', id: callId, reason: 'ended' }]);
  });

  it('never has you in a call and a voice channel at once', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const guild = (await api.post(alice, '/guilds', { name: 'G' })).body;
    const lounge = (await api.post(alice, `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' })).body;
    await api.post(alice, `/guilds/${guild.id}/channels/${lounge.id}/voice`);
    await webhook('participant_joined', `channel-${lounge.id}`, alice);
    expect(voice.states.has(alice.id)).toBe(true);

    const callId = (await ring(alice, bob)).body.call.id;
    expect(voice.states.has(alice.id)).toBe(false);
    expect(liveKitCalls).toContainEqual(['remove', `channel-${lounge.id}`, String(alice.id)]);

    await api.post(alice, `/guilds/${guild.id}/channels/${lounge.id}/voice`);
    expect(calls.calls.has(callId)).toBe(false);
  });
});
