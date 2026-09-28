import './helpers/mockS3.js';
import { sentPushes, pushFailures, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const clients = app.locals.clients;

async function makeAuthedUser(username, password = 'pw-123456') {
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, token: loginRes.body.token };
}
const authed = (token) => ({ Authorization: `Bearer ${token}` });
const subscription = (endpoint) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

async function subscribe(user, endpoint) {
  const res = await request(app).post('/api/save-subscription').set(authed(user.token)).send({ subscription: subscription(endpoint) });
  expect(res.status).toBe(200);
}
function send(from, to, content = 'CIPHERTEXT') {
  return request(app).post('/api/dm-send').set(authed(from.token)).send({ recipient_id: to.id, content });
}
// A connected websocket for `user` reporting the given presence.
function fakeSocket(user, presence) {
  const ws = { readyState: 1, send() {}, presence: { at: Date.now(), ...presence } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return () => clients.set(String(user.id), (clients.get(String(user.id)) || []).filter((s) => s !== ws));
}

describe('push notifications', () => {
  it('exposes the VAPID public key in /api/config', async () => {
    const res = await request(app).get('/api/config');
    expect(res.body.vapidPublicKey).toBe(process.env.VAPID_PUBLIC_KEY);
  });

  it('pushes a new DM to the recipient with the ciphertext for an on-device preview (never a key)', async () => {
    const alice = await makeAuthedUser('push-alice');
    const bob = await makeAuthedUser('push-bob');
    await subscribe(bob, 'https://push.test/bob-1');

    const before = sentPushes.length;
    const res = await send(alice, bob, 'SMALL-CIPHERTEXT');
    expect(res.status).toBe(201);

    const [push] = await waitForPushes(1, before);
    expect(push.endpoint).toBe('https://push.test/bob-1');
    expect(push.payload).toMatchObject({
      type: 'dm', title: 'push-alice', body: 'New message', url: `/dm/${alice.id}`, tag: `dm-${alice.id}`,
      senderId: alice.id, recipientId: bob.id, ciphertext: 'SMALL-CIPHERTEXT',
    });
    // The service worker only uses keys it has already checked; the push carries none.
    expect(JSON.stringify(push.payload)).not.toMatch(/key/i);
    expect(push.options).toMatchObject({ urgency: 'high', topic: `dm${alice.id}` });
  });

  it('leaves the ciphertext out when it would not fit in a push', async () => {
    const alice = await makeAuthedUser('push-alice2');
    const bob = await makeAuthedUser('push-bob2');
    await subscribe(bob, 'https://push.test/bob-2');

    const before = sentPushes.length;
    await send(alice, bob, 'x'.repeat(3000));
    const [push] = await waitForPushes(1, before);
    expect(push.payload.ciphertext).toBeUndefined();
    expect(push.payload.title).toBe('push-alice2');
  });

  it('does not push when the recipient is looking at that conversation', async () => {
    const alice = await makeAuthedUser('push-alice3');
    const bob = await makeAuthedUser('push-bob3');
    await subscribe(bob, 'https://push.test/bob-3');
    const disconnect = fakeSocket(bob, { visible: true, chatId: String(alice.id) });

    const before = sentPushes.length;
    await send(alice, bob);
    const pushes = await waitForPushes(1, before, 300);
    expect(pushes).toHaveLength(0);
    disconnect();
  });

  it('still pushes when the recipient is in another chat, hidden, or their presence is stale', async () => {
    const alice = await makeAuthedUser('push-alice4');
    const bob = await makeAuthedUser('push-bob4');
    await subscribe(bob, 'https://push.test/bob-4');

    for (const presence of [
      { visible: true, chatId: '999999' },
      { visible: false, chatId: String(alice.id) },
      { visible: true, chatId: String(alice.id), at: Date.now() - 60000 },
    ]) {
      const disconnect = fakeSocket(bob, presence);
      const before = sentPushes.length;
      await send(alice, bob);
      expect(await waitForPushes(1, before)).toHaveLength(1);
      disconnect();
    }
  });

  it('moves a device to whoever subscribes on it last', async () => {
    const alice = await makeAuthedUser('push-alice5');
    const bob = await makeAuthedUser('push-bob5');
    const carol = await makeAuthedUser('push-carol5');
    await subscribe(bob, 'https://push.test/shared-device');
    await subscribe(carol, 'https://push.test/shared-device');

    const before = sentPushes.length;
    await send(alice, bob);
    expect(await waitForPushes(1, before, 300)).toHaveLength(0);

    await send(alice, carol);
    expect((await waitForPushes(1, before))[0].endpoint).toBe('https://push.test/shared-device');
  });

  it('stops pushing to a device after it unsubscribes (logout)', async () => {
    const alice = await makeAuthedUser('push-alice6');
    const bob = await makeAuthedUser('push-bob6');
    await subscribe(bob, 'https://push.test/bob-6');

    const del = await request(app).post('/api/delete-subscription').set(authed(bob.token)).send({ endpoint: 'https://push.test/bob-6' });
    expect(del.status).toBe(200);

    const before = sentPushes.length;
    await send(alice, bob);
    expect(await waitForPushes(1, before, 300)).toHaveLength(0);
  });

  it('lets the service worker swap in a replacement subscription by its old endpoint', async () => {
    const alice = await makeAuthedUser('push-alice7');
    const bob = await makeAuthedUser('push-bob7');
    await subscribe(bob, 'https://push.test/bob-7-old');

    const res = await request(app).post('/api/update-subscription')
      .send({ oldEndpoint: 'https://push.test/bob-7-old', subscription: subscription('https://push.test/bob-7-new') });
    expect(res.status).toBe(200);
    const unknown = await request(app).post('/api/update-subscription')
      .send({ oldEndpoint: 'https://push.test/nope', subscription: subscription('https://push.test/x') });
    expect(unknown.status).toBe(404);

    const before = sentPushes.length;
    await send(alice, bob);
    expect((await waitForPushes(1, before))[0].endpoint).toBe('https://push.test/bob-7-new');
  });

  it('forgets subscriptions the push service says are gone', async () => {
    const alice = await makeAuthedUser('push-alice8');
    const bob = await makeAuthedUser('push-bob8');
    await subscribe(bob, 'https://push.test/bob-8-gone');
    await subscribe(bob, 'https://push.test/bob-8-ok');
    pushFailures['https://push.test/bob-8-gone'] = 410;

    let before = sentPushes.length;
    await send(alice, bob);
    await waitForPushes(1, before);
    await new Promise((r) => setTimeout(r, 50));
    delete pushFailures['https://push.test/bob-8-gone'];

    before = sentPushes.length;
    await send(alice, bob);
    const pushes = await waitForPushes(2, before, 300);
    expect(pushes.map((p) => p.endpoint)).toEqual(['https://push.test/bob-8-ok']);
  });

  it("sends a test notification to all of the caller's devices", async () => {
    const bob = await makeAuthedUser('push-bob9');
    await subscribe(bob, 'https://push.test/bob-9a');
    await subscribe(bob, 'https://push.test/bob-9b');

    const before = sentPushes.length;
    const res = await request(app).post('/api/test-push').set(authed(bob.token));
    expect(res.body).toEqual({ devices: 2, delivered: 2 });
    const pushes = sentPushes.slice(before);
    expect(pushes.map((p) => p.payload.type)).toEqual(['test', 'test']);
  });

  it('reports devices it could not deliver the test to', async () => {
    const bob = await makeAuthedUser('push-bob10');
    await subscribe(bob, 'https://push.test/bob-10-ok');
    await subscribe(bob, 'https://push.test/bob-10-broken');
    pushFailures['https://push.test/bob-10-broken'] = 403;

    const res = await request(app).post('/api/test-push').set(authed(bob.token));
    delete pushFailures['https://push.test/bob-10-broken'];

    expect(res.body).toEqual({ devices: 2, delivered: 1 });
  });

  it('reports when the user has no devices set up', async () => {
    const bob = await makeAuthedUser('push-bob11');
    const res = await request(app).post('/api/test-push').set(authed(bob.token));
    expect(res.body).toEqual({ devices: 0, delivered: 0 });
  });
});
