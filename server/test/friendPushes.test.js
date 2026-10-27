import './helpers/mockS3.js';
import { sentPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

// Notifications about friend requests (friendPushes.js).
const app = require('../index.js');
const clients = app.locals.clients;

let count = 0;
async function makeUser() {
  const username = `fpush-${++count}`;
  const { response } = await registerUser(app, request, username, 'pw-friend-push-1');
  const login = await loginUser(app, request, username, 'pw-friend-push-1');
  const user = { id: response.body.id, username, token: login.response.body.token, endpoint: `https://push.test/${username}` };
  await api.post(user, '/save-subscription', { subscription: { endpoint: user.endpoint, keys: { p256dh: 'p', auth: 'a' } } });
  // An open page, collecting the notifications it's told to take down.
  user.cleared = [];
  clients.set(String(user.id), [{ readyState: 1, send: (m) => { const e = JSON.parse(m); if (e.type === 'notification_clear') user.cleared.push(...e.tags); } }]);
  return user;
}
const authed = (u) => ({ Authorization: `Bearer ${u.token}` });
const api = {
  put: (u, url, body = {}) => request(app).put(`/api${url}`).set(authed(u)).send(body),
  post: (u, url, body = {}) => request(app).post(`/api${url}`).set(authed(u)).send(body),
  delete: (u, url) => request(app).delete(`/api${url}`).set(authed(u)),
};

const settle = () => new Promise((r) => setTimeout(r, 100));
const pushesTo = (user, since) => sentPushes.slice(since).filter((p) => p.endpoint === user.endpoint && p.payload.type === 'friend').map((p) => p.payload);

describe('friend request notifications', () => {
  it('tell the asked person, then the asker when accepted, and go once answered', async () => {
    const [ann, bob] = [await makeUser(), await makeUser()];
    const since = sentPushes.length;
    expect((await api.put(ann, `/friends/${bob.id}`)).body.result).toBe('requested');
    await settle();
    expect(pushesTo(bob, since)).toEqual([expect.objectContaining({
      type: 'friend', kind: 'request', name: ann.username, title: ann.username, url: '/dm/friends', tag: `friend-${ann.id}`,
    })]);
    expect(pushesTo(ann, since)).toEqual([]);

    // Asking again straight away doesn't buzz again.
    await api.delete(ann, `/friends/${bob.id}`);
    await settle();
    expect(bob.cleared).toEqual([`friend-${ann.id}`]);
    await api.put(ann, `/friends/${bob.id}`);
    await settle();
    expect(pushesTo(bob, since)).toHaveLength(1);

    expect((await api.put(bob, `/friends/${ann.id}`)).body.result).toBe('accepted');
    await settle();
    expect(pushesTo(ann, since)).toEqual([expect.objectContaining({
      type: 'friend', kind: 'accepted', name: bob.username, url: `/dm/${bob.id}`, tag: `friend-${bob.id}`,
    })]);
    expect(pushesTo(bob, since)).toHaveLength(1);
  });

  it('come by username too, and a declined one goes from the devices', async () => {
    const [ann, bob] = [await makeUser(), await makeUser()];
    const since = sentPushes.length;
    await api.post(ann, '/friends', { username: bob.username });
    await settle();
    expect(pushesTo(bob, since)).toEqual([expect.objectContaining({ kind: 'request', tag: `friend-${ann.id}` })]);
    await api.delete(bob, `/friends/${ann.id}`);
    await settle();
    expect(bob.cleared).toEqual([`friend-${ann.id}`]);
    expect(ann.cleared).toEqual([]);
  });

  it("aren't sent when a block stops the request, and blocking takes one down", async () => {
    const [ann, bob, cal] = [await makeUser(), await makeUser(), await makeUser()];
    await api.put(bob, `/blocks/${ann.id}`);
    const since = sentPushes.length;
    expect((await api.put(ann, `/friends/${bob.id}`)).status).toBe(403);
    await api.put(cal, `/friends/${bob.id}`);
    await settle();
    expect(pushesTo(bob, since).map((p) => p.tag)).toEqual([`friend-${cal.id}`]);
    await api.put(bob, `/blocks/${cal.id}`);
    await settle();
    expect(bob.cleared).toEqual([`friend-${cal.id}`]);
  });
});
