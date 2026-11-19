import './helpers/mockS3.js';
import { sentPushes } from './helpers/mockWebPush.js';
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { registerUser, loginUser } from './helpers/authFlow.js';

// The limits of chatLimits.js and the other per-account limits from the security audit's L3
// (DMs, rings, polls, the tester form, admins' pushes). On for this file only (see setupEnv.js).
process.env.DISABLE_RATE_LIMITS = '';
const app = require('../index.js');
const db = require('../db');
const calls = require('../calls.js');
const voice = require('../voice.js');
const { createDistinctLimiter, addressKey } = require('../rateLimit');

let count = 0;
async function makeUser({ admin = false } = {}) {
  const username = `limits-${++count}`;
  const { response } = await registerUser(app, request, username, 'pw-limits-123');
  if (admin) await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [response.body.id]);
  const login = await loginUser(app, request, username, 'pw-limits-123');
  return { id: response.body.id, token: login.response.body.token };
}
const authed = (u) => ({ Authorization: `Bearer ${u.token}` });
const post = (u, url, body = {}) => request(app).post(`/api${url}`).set(authed(u)).send(body);
async function befriend(a, b) {
  for (const [x, y] of [[a.id, b.id], [b.id, a.id]]) {
    await db.run('INSERT INTO friends (user_id, friend_id, created_at) VALUES (?, ?, 0)', [x, y]);
  }
}
const dm = (from, to, i = 0) => post(from, '/dm-send', { recipient_id: to.id, content: `v1.${'A'.repeat(40)}${i}` });

afterEach(async () => {
  for (const call of [...calls.calls.values()]) await calls.endCall(call, 'ended');
});

describe('DM limits', () => {
  it('lets a stranger send only a few a minute, a friend or someone who wrote back many more', async () => {
    const [ann, bob, cal, dan] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    for (let i = 0; i < 5; i++) expect((await dm(ann, bob, i)).status).toBe(201);
    const blocked = await dm(ann, bob, 5);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    await befriend(ann, cal);
    for (let i = 0; i < 10; i++) expect((await dm(ann, cal, i)).status).toBe(201);

    // Once Dan has written to Ann, she's no stranger to him.
    expect((await dm(dan, ann)).status).toBe(201);
    for (let i = 0; i < 10; i++) expect((await dm(ann, dan, i)).status).toBe(201);
  });

  it('caps everyone at 60 a minute, notes included', async () => {
    const ann = await makeUser();
    for (let i = 0; i < 60; i++) expect((await dm(ann, ann, i)).status).toBe(201);
    expect((await dm(ann, ann, 60)).status).toBe(429);
  });

  it('counts the different strangers someone starts writing to', () => {
    const limiter = createDistinctLimiter({ windowMs: 60000, max: 2 });
    expect(limiter.hit('ann', 1).allowed).toBe(true);
    expect(limiter.hit('ann', 2).allowed).toBe(true);
    expect(limiter.hit('ann', 1).allowed).toBe(true);
    expect(limiter.hit('ann', 3).allowed).toBe(false);
    expect(limiter.hit('bob', 3).allowed).toBe(true);
  });
});

describe('ring limits', () => {
  const ring = (from, to) => post(from, '/dm-calls', { calleeId: to.id, callId: randomUUID(), keyEnvelope: `v1.${'A'.repeat(100)}` });

  it('rings a stranger 3 times in 10 minutes, a friend more', async () => {
    voice.livekit.roomService = { removeParticipant: async () => {}, deleteRoom: async () => {}, listParticipants: async () => [] };
    const [ann, bob, cal] = [await makeUser(), await makeUser(), await makeUser()];
    for (let i = 0; i < 3; i++) expect((await ring(ann, bob)).status).toBe(201);
    expect((await ring(ann, bob)).status).toBe(429);
    await befriend(ann, cal);
    // 10 in 10 minutes in all, the refused one counted too.
    for (let i = 0; i < 6; i++) expect((await ring(ann, cal)).status).toBe(201);
    expect((await ring(ann, cal)).status).toBe(429);
  });
});

describe('poll limits', () => {
  it('takes 20 poll timers or ends a minute per account', async () => {
    const ann = await makeUser();
    for (let i = 0; i < 20; i++) expect((await post(ann, '/polls/dm/999999/end')).status).toBe(404);
    expect((await post(ann, '/polls/dm/999999/end')).status).toBe(429);
  });
});

describe('tester form', () => {
  const apply = (ip, email) => request(app).post('/api/tester-requests').set('X-Forwarded-For', ip).send({ email });
  let since;
  it('has an admin to tell', async () => {
    const admin = await makeUser({ admin: true });
    await post(admin, '/save-subscription', { subscription: { endpoint: `https://push.test/${admin.id}`, keys: { p256dh: 'p', auth: 'a' } } });
    since = sentPushes.length;
  });

  it('limits an IPv6 /64 as one address', async () => {
    expect(addressKey('2001:db8:1:2::1')).toBe(addressKey('2001:db8:1:2:ffff::9'));
    expect(addressKey('2001:db8:1:2::1')).not.toBe(addressKey('2001:db8:1:3::1'));
    for (let i = 1; i <= 5; i++) expect((await apply(`2001:db8:1:2::${i}`, `six${i}@example.com`)).status).toBe(201);
    expect((await apply('2001:db8:1:2::99', 'six99@example.com')).status).toBe(429);
    expect((await apply('2001:db8:1:3::1', 'other@example.com')).status).toBe(201);
  });

  it('pushes admins once for a burst, and takes at most 50 new requests an hour from everyone', async () => {
    const statuses = [];
    // Two requests (one per address) from each of 30 addresses; 6 already came in above.
    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 2; j++) statuses.push((await apply(`10.9.${i}.1`, `burst${i}-${j}@example.com`)).status);
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(44);
    expect(statuses.filter((s) => s === 503)).toHaveLength(16);
    await new Promise((r) => setTimeout(r, 100));
    const adminPushes = sentPushes.slice(since).filter((p) => p.payload.type === 'admin' && p.payload.kind === 'tester');
    expect(adminPushes).toHaveLength(1);
  });
});
