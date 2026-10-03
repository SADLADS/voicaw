import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createDecipheriv, generateKeyPairSync, randomBytes, randomUUID } from 'crypto';
import { inflateRawSync } from 'zlib';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { registerUser, loginUser } from './helpers/authFlow.js';

// The Android app's notifications (fcm.js): a throwaway service account, and Google's two
// endpoints answered by a stand-in `fetch`.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const accountFile = path.join(mkdtempSync(path.join(tmpdir(), 'voicaw-fcm-')), 'account.json');
writeFileSync(accountFile, JSON.stringify({
  project_id: 'voicaw-test',
  client_email: 'push@voicaw-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
}));
process.env.FCM_SERVICE_ACCOUNT = accountFile;

const app = require('../index.js');
const calls = require('../calls.js');
const db = require('../db.js');

const sent = []; // { token, message, auth }
const unregistered = new Set();
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
  if (url === 'https://oauth2.googleapis.com/token') {
    return Response.json({ access_token: 'google-access-token', expires_in: 3600 });
  }
  if (String(url).startsWith('https://fcm.googleapis.com/')) {
    const { message } = JSON.parse(init.body);
    if (unregistered.has(message.token)) {
      return Response.json({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 });
    }
    sent.push({ url, token: message.token, message, auth: init.headers.Authorization });
    return Response.json({ name: 'projects/voicaw-test/messages/1' });
  }
  return realFetch(url, init);
});
afterAll(() => vi.restoreAllMocks());

let userCount = 0;
async function makeUser() {
  const username = `fcm-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-fcm-12345');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-fcm-12345');
  return { id: regRes.body.id, username, token: loginRes.body.token };
}
const post = (user, url, body = {}) => request(app).post(`/api${url}`).set({ Authorization: `Bearer ${user.token}` }).send(body);

// Registers an Android phone for `user`; resolves to its token and key.
async function registerPhone(user) {
  const phone = { token: `phone-${randomUUID()}`, key: randomBytes(32).toString('base64') };
  const res = await post(user, '/save-subscription', { subscription: { endpoint: `fcm:${phone.token}`, fcm: phone } });
  expect(res.status).toBe(200);
  return phone;
}

// What the phone reads out of an FCM message (as PushCrypto.java does).
function open(message, key) {
  expect(message.data.v).toBe('1');
  const sealed = Buffer.from(message.data.p, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
  return JSON.parse(inflateRawSync(plain).toString());
}

async function waitForSent(count, since, timeoutMs = 2000) {
  const start = Date.now();
  while (sent.length - since < count && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 10));
  return sent.slice(since);
}

beforeEach(() => {
  unregistered.clear();
});

describe('Android app notifications (FCM)', () => {
  it('only takes a well-formed phone registration', async () => {
    const user = await makeUser();
    const key = randomBytes(32).toString('base64');
    for (const subscription of [
      { endpoint: 'fcm:abc', fcm: { token: 'abc', key: 'short' } },
      { endpoint: 'fcm:abc', fcm: { token: 'other', key } },
      { endpoint: 'fcm:abc' },
    ]) {
      expect((await post(user, '/save-subscription', { subscription })).status).toBe(400);
    }
    expect((await post(user, '/save-subscription', { subscription: { endpoint: 'fcm:abc', fcm: { token: 'abc', key, extra: 1 } } })).status).toBe(200);
    const row = await db.get('SELECT subscription FROM push_subscriptions WHERE endpoint = ?', ['fcm:abc']);
    expect(JSON.parse(row.subscription)).toEqual({ endpoint: 'fcm:abc', fcm: { token: 'abc', key } });
  });

  it('sends a DM push encrypted with the phone key, so Google only relays ciphertext', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const phone = await registerPhone(bob);
    const since = sent.length;
    expect((await post(alice, '/dm-send', { recipient_id: bob.id, content: 'E2EE-CIPHERTEXT' })).status).toBe(201);
    const [fcm] = await waitForSent(1, since);
    expect(fcm.url).toBe('https://fcm.googleapis.com/v1/projects/voicaw-test/messages:send');
    expect(fcm.auth).toBe('Bearer google-access-token');
    expect(fcm.token).toBe(phone.token);
    expect(fcm.message.android.priority).toBe('high');
    expect(Object.keys(fcm.message.data).sort()).toEqual(['p', 'v']);
    expect(fcm.message.data.p).not.toContain(alice.username);
    expect(open(fcm.message, phone.key)).toMatchObject({
      type: 'dm', title: alice.username, senderId: alice.id, recipientId: bob.id, ciphertext: 'E2EE-CIPHERTEXT', tag: `dm-${alice.id}`,
    });
  });

  it('fits the longest message a web push carries', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const phone = await registerPhone(bob);
    const since = sent.length;
    const content = `v1.${randomBytes(2097).toString('base64')}`; // 2800 characters, push.js's limit
    expect((await post(alice, '/dm-send', { recipient_id: bob.id, content })).status).toBe(201);
    const [fcm] = await waitForSent(1, since);
    expect(fcm.message.data.p.length).toBeLessThanOrEqual(3900);
    expect(open(fcm.message, phone.key).ciphertext).toBe(content);
  });

  it('leaves the message out of anything too big for FCM', () => {
    const { fcmData } = require('../fcm.js');
    const key = randomBytes(32).toString('base64');
    const data = fcmData({ type: 'dm', ciphertext: randomBytes(4000).toString('base64') }, key);
    expect(data.p.length).toBeLessThanOrEqual(3900);
    expect(open({ data }, key)).toEqual({ type: 'dm' });
  });

  it('forgets a phone whose token Firebase no longer knows', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const phone = await registerPhone(bob);
    unregistered.add(phone.token);
    await post(alice, '/dm-send', { recipient_id: bob.id, content: 'E2EE' });
    const start = Date.now();
    while (Date.now() - start < 2000 && await db.get('SELECT 1 FROM push_subscriptions WHERE endpoint = ?', [`fcm:${phone.token}`])) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await db.get('SELECT 1 FROM push_subscriptions WHERE endpoint = ?', [`fcm:${phone.token}`])).toBeUndefined();
  });

  it('rings a phone with the call id, and stops it ringing once answered elsewhere', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const phone = await registerPhone(bob);
    const callId = randomUUID();
    const since = sent.length;
    expect((await post(alice, '/dm-calls', { calleeId: bob.id, callId, keyEnvelope: `v1.${'A'.repeat(100)}` })).status).toBe(201);
    const [ring] = await waitForSent(1, since);
    expect(open(ring.message, phone.key)).toMatchObject({ type: 'call', callId, ringing: true, tag: `call-${callId}` });

    expect((await post(bob, `/dm-calls/${callId}/accept`)).status).toBe(200);
    const [, stop] = await waitForSent(2, since);
    expect(open(stop.message, phone.key)).toEqual({ type: 'call_stop', callId });
    await calls.endCall(calls.calls.get(callId), 'ended');
  });

  it('stops a phone ringing when the call is declined, and says missed when nobody answers', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const phone = await registerPhone(bob);
    const declined = randomUUID();
    let since = sent.length;
    await post(alice, '/dm-calls', { calleeId: bob.id, callId: declined, keyEnvelope: `v1.${'A'.repeat(100)}` });
    await waitForSent(1, since);
    await post(bob, `/dm-calls/${declined}/decline`);
    const [, stop] = await waitForSent(2, since);
    expect(open(stop.message, phone.key)).toEqual({ type: 'call_stop', callId: declined });

    const missed = randomUUID();
    since = sent.length;
    await post(alice, '/dm-calls', { calleeId: bob.id, callId: missed, keyEnvelope: `v1.${'A'.repeat(100)}` });
    await waitForSent(1, since);
    await calls.endCall(calls.calls.get(missed), 'missed');
    const [, missedPush] = await waitForSent(2, since);
    expect(open(missedPush.message, phone.key)).toMatchObject({ type: 'call', callId: missed, ringing: false, body: 'Missed call' });
  });
});
