import './helpers/mockS3.js';
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import WebSocket from 'ws';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { attachWebSocketServer, refreshStatus, getStatus } = require('../sockets.js');
const db = require('../db.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser() {
  const username = `presence-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-presence-1');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-presence-1');
  return { id: regRes.body.id, token: loginRes.body.token };
}

// A real websocket server on a free port, like index.js runs it.
const server = http.createServer(app);
const wss = attachWebSocketServer(server);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${server.address().port}`;
afterAll(() => {
  wss.close();
  server.close();
});

// A connected socket and the messages it has received; `next(type)` waits for one.
async function connect() {
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
  return { ws, received, next };
}
const presence = (fields) => JSON.stringify({ type: 'presence', visible: true, chatId: null, ...fields });
const isStatus = (userId, status) => (e) => e.type === 'user_status' && e.userId === String(userId) && e.status === status;

describe('online status over the websocket', () => {
  it('reports a new connection with its presence, and sends a snapshot on identify', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const a = await connect();
    a.ws.send(presence({ idleIn: 60000 }));
    a.ws.send(JSON.stringify({ type: 'identify', token: alice.token }));
    const snap = await a.next((e) => e.type === 'presence_snapshot');
    expect(snap.statuses[alice.id]).toBe('online');

    // Bob on a phone: mobile. Alice hears about it.
    const b = await connect();
    b.ws.send(presence({ idleIn: 60000, mobile: true }));
    b.ws.send(JSON.stringify({ type: 'identify', token: bob.token }));
    expect((await b.next((e) => e.type === 'presence_snapshot')).statuses).toMatchObject({ [alice.id]: 'online', [bob.id]: 'mobile' });
    await a.next(isStatus(bob.id, 'mobile'));

    // Bob also on a computer: online wins. Then only the computer goes idle: back to mobile.
    const b2 = await connect();
    b2.ws.send(presence({ idleIn: 60000 }));
    b2.ws.send(JSON.stringify({ type: 'identify', token: bob.token }));
    await a.next(isStatus(bob.id, 'online'));
    b2.ws.send(presence({ idleIn: 0 }));
    await a.next(isStatus(bob.id, 'mobile'));
    // And the phone too: idle.
    b.ws.send(presence({ idleIn: 0, mobile: true }));
    await a.next(isStatus(bob.id, 'idle'));
    expect(getStatus(bob.id)).toBe('idle');

    for (const s of [a, b, b2]) s.ws.close();
  });

  it('does not keep a socket that closed while its token was being checked', async () => {
    const carol = await makeUser();
    // Hold the token check until the socket has closed.
    const auth = require('../auth.js');
    const { verifyToken } = auth;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    auth.verifyToken = async (token) => { await held; return verifyToken(token); };
    try {
      const c = await connect();
      c.ws.send(JSON.stringify({ type: 'identify', token: carol.token }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      c.ws.close();
      await new Promise((resolve) => c.ws.on('close', resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      auth.verifyToken = verifyToken;
    }
    expect(clients.has(String(carol.id))).toBe(false);
    expect(getStatus(carol.id)).toBe('offline');
  });

  it('does not repeat a status nobody changed', async () => {
    const dave = await makeUser();
    const watcher = await makeUser();
    const w = await connect();
    w.ws.send(JSON.stringify({ type: 'identify', token: watcher.token }));
    await w.next((e) => e.type === 'presence_snapshot');
    const d = await connect();
    d.ws.send(presence({ idleIn: 60000 }));
    d.ws.send(JSON.stringify({ type: 'identify', token: dave.token }));
    await w.next(isStatus(dave.id, 'online'));
    // A second tab and more presence: still online, nothing sent.
    const d2 = await connect();
    d2.ws.send(presence({ idleIn: 60000 }));
    d2.ws.send(JSON.stringify({ type: 'identify', token: dave.token }));
    await d2.next((e) => e.type === 'presence_snapshot');
    d.ws.send(presence({ idleIn: 30000 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(w.received.filter((e) => e.type === 'user_status' && e.userId === String(dave.id))).toEqual([]);
    for (const s of [w, d, d2]) s.ws.close();
  });
});

describe('going offline', () => {
  afterEach(() => vi.useRealTimers());

  // A connected socket for `user` that last reported the given presence.
  function fakeSocket(user, presenceFields) {
    const ws = { readyState: 1, send() {}, presence: { at: Date.now(), ...presenceFields } };
    clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
    return () => {
      const rest = clients.get(String(user.id)).filter((s) => s !== ws);
      if (rest.length) clients.set(String(user.id), rest);
      else clients.delete(String(user.id));
    };
  }
  function listen(user) {
    const events = [];
    const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
    clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
    return events;
  }

  it('waits a moment before saying so, and forgets it when they come back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const erin = await makeUser();
    const watcher = await makeUser();
    const events = listen(watcher);
    const erinEvents = () => events.filter((e) => e.userId === String(erin.id)).map((e) => e.status);

    let disconnect = fakeSocket(erin, { activeUntil: Date.now() + 60000 });
    refreshStatus(erin.id);
    expect(erinEvents()).toEqual(['online']);

    // A reload: gone for a few seconds, then back. Nobody hears about it.
    disconnect();
    refreshStatus(erin.id);
    vi.advanceTimersByTime(5000);
    disconnect = fakeSocket(erin, { activeUntil: Date.now() + 60000 });
    refreshStatus(erin.id);
    vi.advanceTimersByTime(60000);
    expect(erinEvents()).toEqual(['online']);

    // Gone for good: offline after the grace period, with when they were last seen.
    disconnect();
    refreshStatus(erin.id);
    vi.advanceTimersByTime(14000);
    expect(erinEvents()).toEqual(['online']);
    vi.advanceTimersByTime(2000);
    expect(erinEvents()).toEqual(['online', 'offline']);
    const offline = events.find((e) => e.userId === String(erin.id) && e.status === 'offline');
    expect(offline.lastOnline).toBe(Math.floor(Date.now() / 1000) - 1);
    expect(getStatus(erin.id)).toBe('offline');

    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = await db.get('SELECT last_online FROM users WHERE id = ?', [erin.id]);
    expect(row.last_online).toBe(offline.lastOnline);
    clients.delete(String(watcher.id));
  });

  it('lists status and last seen in the DM list', async () => {
    const frank = await makeUser();
    const other = await makeUser();
    const disconnect = fakeSocket(other, {});
    refreshStatus(other.id);
    const res = await request(app).get('/api/dms-list').set({ Authorization: `Bearer ${frank.token}` });
    expect(res.body.find((u) => u.id === other.id)).toMatchObject({ status: 'idle', last_online: expect.any(Number) });
    disconnect();
  });
});
