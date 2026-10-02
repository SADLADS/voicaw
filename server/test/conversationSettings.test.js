import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'conv-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-conv-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};

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

const dm = (from, to) => api.post(from, '/dm-send', { recipient_id: to.id, content: 'CIPHERTEXT' });

async function pushesSince(since) {
  await waitForPushes(1000, since, 300);
  return sentPushes.slice(since);
}

describe('conversation settings', () => {
  it('pins and unpins DMs, in the order pinned, on your other devices too', async () => {
    const [ann, bob, cat] = [await makeUser(), await makeUser(), await makeUser()];
    const events = connect(ann);
    const res = await api.put(ann, `/conversation-settings/dm/${cat.id}`, { pinned: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'dm', target: String(cat.id), muted: false, mute_until: null });
    expect(res.body.pinned_at).toEqual(expect.any(Number));
    expect(events).toContainEqual({ type: 'conversation_settings', setting: res.body });
    await api.put(ann, `/conversation-settings/dm/${bob.id}`, { pinned: true });
    expect((await api.get(ann, '/conversation-settings')).body.map((s) => s.target)).toEqual([String(cat.id), String(bob.id)]);
    expect((await api.get(bob, '/conversation-settings')).body).toEqual([]);

    await api.put(ann, `/conversation-settings/dm/${cat.id}`, { pinned: false });
    expect((await api.get(ann, '/conversation-settings')).body.map((s) => s.target)).toEqual([String(bob.id)]);
    events.stop();
  });

  it('a muted DM pushes nothing until it runs out or is unmuted; pinning keeps the mute', async () => {
    const [ann, bob] = [await makeUser(), await makeUser()];
    const endpoint = await subscribe(ann);
    const muted = await api.put(ann, `/conversation-settings/dm/${bob.id}`, { mute: { duration: 3600 } });
    expect(muted.body).toMatchObject({ muted: true, pinned_at: null });
    expect(muted.body.mute_until).toBeGreaterThan(Date.now() / 1000 + 3500);

    let since = sentPushes.length;
    await dm(bob, ann);
    expect(await pushesSince(since)).toEqual([]);
    // The message still arrives and counts as unread.
    expect((await api.get(ann, '/dm-get-unread')).body).toContainEqual(expect.objectContaining({ from_user_id: bob.id }));

    expect((await api.put(ann, `/conversation-settings/dm/${bob.id}`, { pinned: true })).body).toMatchObject({ muted: true });

    // Running out.
    const realNow = Date.now;
    Date.now = () => realNow() + 3601_000;
    try {
      since = sentPushes.length;
      await dm(bob, ann);
      expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([endpoint]);
      expect((await api.get(ann, '/conversation-settings')).body[0]).toMatchObject({ muted: false });
    } finally {
      Date.now = realNow;
    }

    // Until unmuted, then unmuted.
    await api.put(ann, `/conversation-settings/dm/${bob.id}`, { mute: { duration: null } });
    since = sentPushes.length;
    await dm(bob, ann);
    expect(await pushesSince(since)).toEqual([]);
    expect((await api.put(ann, `/conversation-settings/dm/${bob.id}`, { mute: false })).body).toMatchObject({ muted: false });
    since = sentPushes.length;
    await dm(bob, ann);
    expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([endpoint]);
  });

  it('refuses bad input, strangers, yourself and groups you are not in', async () => {
    const [ann, bob] = [await makeUser(), await makeUser()];
    expect((await api.put(ann, `/conversation-settings/channel/${bob.id}`, { pinned: true })).status).toBe(400);
    expect((await api.put(ann, `/conversation-settings/dm/${bob.id}`, { pinned: 'yes' })).status).toBe(400);
    for (const mute of [{ duration: 0 }, { duration: 'soon' }, true, 5]) {
      expect((await api.put(ann, `/conversation-settings/dm/${bob.id}`, { mute })).status).toBe(400);
    }
    expect((await api.put(ann, '/conversation-settings/dm/999999', { pinned: true })).status).toBe(404);
    expect((await api.put(ann, `/conversation-settings/dm/${ann.id}`, { pinned: true })).status).toBe(404);
    expect((await api.put(ann, '/conversation-settings/group/00000000-0000-4000-8000-000000000000', { pinned: true })).status).toBe(404);
    expect((await api.get(ann, '/conversation-settings')).body).toEqual([]);
  });
});
