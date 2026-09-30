import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const clients = app.locals.clients;

// Notes are a DM to yourself (sender = recipient), encrypted on the device with a key only
// your own key pair derives; the server just stores them like any DM.

let userCount = 0;
async function makeUser() {
  const username = `notes-user-${++userCount}`;
  const password = 'pw-notes-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  const user = { id: regRes.body.id, username, token: loginRes.body.token };
  user.endpoint = `https://push.test/${username}`;
  await api.post(user, '/save-subscription', { subscription: { endpoint: user.endpoint, keys: { p256dh: 'p', auth: 'a' } } });
  return user;
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

// A connected socket for `user`, collecting its events.
function connect(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now() } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

describe('notes (a DM to yourself)', () => {
  it('stores and returns them, without unread counts, pushes or duplicate events', async () => {
    const alice = await makeUser();
    const events = connect(alice);
    const since = sentPushes.length;

    const sent = await api.post(alice, '/dm-send', { recipient_id: alice.id, content: 'v1.note-1' });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ sender_id: alice.id, recipient_id: alice.id });
    expect(events.filter((e) => e.type === 'new_dm')).toHaveLength(1);

    expect((await api.get(alice, '/dm-get-unread')).body).toEqual([]);
    expect(await waitForPushes(1, since, 300)).toEqual([]);

    const history = await api.get(alice, `/dm-messages/${alice.id}`);
    expect(history.body.map((m) => m.content)).toEqual(['v1.note-1']);

    const reply = await api.post(alice, '/dm-send', { recipient_id: alice.id, content: 'v1.note-2', replyTo: sent.body.id });
    expect(reply.status).toBe(201);

    expect((await api.put(alice, `/update-message/${sent.body.id}`, { content: 'v1.note-1b' })).status).toBe(200);
    expect(events.filter((e) => e.type === 'edit_dm')).toHaveLength(1);
    expect((await api.delete(alice, `/messages/${reply.body.id}`)).status).toBe(200);
    expect(events.filter((e) => e.type === 'delete_dm')).toHaveLength(1);
  });

  it("aren't in the conversation list, and nobody else sees them", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await api.post(alice, '/dm-send', { recipient_id: alice.id, content: 'v1.private' });

    const list = (await api.get(alice, '/dms-list')).body;
    expect(list.some((u) => u.id === alice.id)).toBe(false);

    const bobsView = await api.get(bob, `/dm-messages/${alice.id}`);
    expect(bobsView.body.some((m) => m.content === 'v1.private')).toBe(false);
  });
});
