import './helpers/mockS3.js';
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import WebSocket from 'ws';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { attachWebSocketServer } = require('../sockets.js');
const { cleanActivities, cleanBotActivities, discordActivity, storeImage } = require('../activities.js');

let userCount = 0;
async function makeUser() {
  const username = `activity-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-activity-1');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-activity-1');
  return { id: regRes.body.id, token: loginRes.body.token };
}

const server = http.createServer(app);
const wss = attachWebSocketServer(server);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${server.address().port}`;
afterAll(() => {
  wss.close();
  server.close();
});

async function connect(user) {
  const ws = new WebSocket(url);
  const received = [];
  const waiters = [];
  ws.on('message', (m) => {
    const data = JSON.parse(m);
    const waiter = waiters.find((w) => w.match(data));
    if (!waiter) return received.push(data);
    waiters.splice(waiters.indexOf(waiter), 1);
    waiter.resolve(data);
  });
  await new Promise((resolve) => ws.on('open', resolve));
  const next = (match) => new Promise((resolve) => {
    const found = received.find(match);
    if (found) { received.splice(received.indexOf(found), 1); resolve(found); } else waiters.push({ match, resolve });
  });
  ws.send(JSON.stringify({ type: 'presence', visible: true, idleIn: 60000 }));
  ws.send(JSON.stringify({ type: 'identify', token: user.token }));
  const snapshot = await next((e) => e.type === 'presence_snapshot');
  return { ws, received, next, snapshot, send: (data) => ws.send(JSON.stringify(data)) };
}
const activitiesOf = (userId) => (e) => e.type === 'user_activities' && e.userId === String(userId);

// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('activities (Rich Presence)', () => {
  it('cleans what apps and bots send', () => {
    const [a] = cleanActivities([{
      name: '  Hades ', type: 9, details: 'x'.repeat(200), state: 'Tartarus', start: 1700000000000, end: 'soon',
      partySize: 2, partyMax: null, imageText: 'Zagreus', image: { data: 'not a picture' }, extra: 'dropped',
    }]);
    expect(a).toEqual({
      name: 'Hades', type: 0, details: 'x'.repeat(128), state: 'Tartarus', start: 1700000000000, end: null,
      partySize: null, partyMax: null, imageText: 'Zagreus', image: null,
    });
    expect(cleanActivities('nope')).toEqual([]);
    expect(cleanActivities([{}, {}, {}, {}])).toHaveLength(3);
    expect(cleanBotActivities([{ name: 'Custom Status', type: 4, state: 'Helping out' }, { name: '3 guilds', type: 3 }, { type: 0 }]))
      .toMatchObject([{ name: null, type: 4, state: 'Helping out' }, { name: '3 guilds', type: 3 }]);
    expect(discordActivity({ ...a, partySize: 1, partyMax: 4 })).toEqual({
      name: 'Hades', type: 0, created_at: 1700000000000, details: 'x'.repeat(128), state: 'Tartarus',
      timestamps: { start: 1700000000000 }, party: { size: [1, 4] }, assets: { large_text: 'Zagreus' },
    });
  });

  it('keeps only real pictures, and serves them by their hash', async () => {
    expect(storeImage(Buffer.from('<svg/>').toString('base64'))).toBeNull();
    expect(storeImage('A'.repeat(100000))).toBeNull();
    const id = storeImage(PNG);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const res = await request(app).get(`/api/activity-images/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.body).toString('base64')).toBe(PNG);
    expect((await request(app).get(`/api/activity-images/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await request(app).get('/api/activity-images/..%2f')).status).toBe(404);
  });

  it("tells everyone what someone is playing, in snapshots too, until their app disconnects", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const a = await connect(alice);
    const b = await connect(bob);

    a.send({ type: 'activity', activities: [{ name: 'Hades', state: 'Tartarus', image: { id: 'x', data: PNG } }] });
    const event = await b.next(activitiesOf(alice.id));
    expect(event.activities).toEqual([expect.objectContaining({ name: 'Hades', state: 'Tartarus', image: expect.stringMatching(/^[0-9a-f]{32}$/) })]);
    const imageId = event.activities[0].image;
    expect((await request(app).get(`/api/activity-images/${imageId}`)).status).toBe(200);

    // The same again changes nothing; a picture already sent can go by its id alone.
    a.send({ type: 'activity', activities: [{ name: 'Hades', state: 'Tartarus', image: { id: imageId } }] });
    a.send({ type: 'activity', activities: [{ name: 'Hades', state: 'Elysium', image: { id: imageId } }] });
    expect((await b.next(activitiesOf(alice.id))).activities[0]).toMatchObject({ state: 'Elysium', image: imageId });

    // Someone connecting now gets it in their snapshot.
    const late = await connect(await makeUser());
    expect(late.snapshot.activities[String(alice.id)]).toEqual([expect.objectContaining({ name: 'Hades', state: 'Elysium' })]);

    a.ws.close();
    expect((await b.next(activitiesOf(alice.id))).activities).toEqual([]);
    b.ws.close();
    late.ws.close();
  });

  it('keeps one device clearing its games from hiding another device\'s', async () => {
    const carol = await makeUser();
    const watcher = await connect(await makeUser());
    const pc = await connect(carol);
    const laptop = await connect(carol);
    pc.send({ type: 'activity', activities: [{ name: 'Celeste' }] });
    await watcher.next(activitiesOf(carol.id));
    laptop.send({ type: 'activity', activities: [] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(watcher.received.some(activitiesOf(carol.id))).toBe(false);
    pc.send({ type: 'activity', activities: [] });
    expect((await watcher.next(activitiesOf(carol.id))).activities).toEqual([]);
    for (const s of [watcher, pc, laptop]) s.ws.close();
  });
});
