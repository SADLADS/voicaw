import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const clients = app.locals.clients;

// The desktop app can't get web push, so what would be pushed also goes to its websocket as
// `notification { payload }`, only to sockets that said they're the desktop app with
// notifications on.

let userCount = 0;
async function makeUser() {
  const username = `desktop-user-${++userCount}`;
  const password = 'pw-desktop-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const send = (user, url, body) => request(app).post(`/api${url}`).set({ Authorization: `Bearer ${user.token}` }).send(body);

function connect(user, presence) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now(), ...presence } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

const notifications = (events) => events.filter((e) => e.type === 'notification');

describe('desktop app notifications', () => {
  it('sends what would be pushed to desktop app sockets, and not to others', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const desktop = connect(bob, { desktopNotifications: true });
    const browser = connect(bob, {});
    const since = sentPushes.length;

    const sent = await send(alice, '/dm-send', { recipient_id: bob.id, content: 'v1.hello' });
    expect(sent.status).toBe(201);

    await expect.poll(() => notifications(desktop).length).toBe(1);
    expect(notifications(desktop)[0].payload).toMatchObject({
      type: 'dm', url: `/dm/${alice.id}`, ciphertext: 'v1.hello', senderId: alice.id, recipientId: bob.id,
    });
    expect(notifications(browser)).toEqual([]);
    // Bob has no web push subscription: nothing went there.
    expect(await waitForPushes(1, since, 200)).toEqual([]);
  });

  it('skips a chat the user is looking at, like web push', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const desktop = connect(bob, { desktopNotifications: true, visible: true, chatId: String(alice.id) });

    expect((await send(alice, '/dm-send', { recipient_id: bob.id, content: 'v1.seen' })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 200));
    expect(notifications(desktop)).toEqual([]);
  });

  it('counts the desktop app in the test notification', async () => {
    const carol = await makeUser();
    const desktop = connect(carol, { desktopNotifications: true });
    const res = await send(carol, '/test-push', {});
    expect(res.body).toEqual({ devices: 1, delivered: 1 });
    expect(notifications(desktop)).toHaveLength(1);
  });
});
