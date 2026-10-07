import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'prefs-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-prefs-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};

function connect(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

describe('account preferences', () => {
  it('defaults, changes and tells your other devices', async () => {
    const [ann, bob] = [await makeUser(), await makeUser()];
    expect((await api.get(ann, '/preferences')).body).toEqual({ blurNsfw: true, adultConfirmed: false, botDms: true, reactionNotifications: 'all' });
    expect((await request(app).get('/api/preferences')).status).toBe(401);

    const events = connect(ann);
    const res = await api.put(ann, '/preferences', { blurNsfw: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blurNsfw: false, adultConfirmed: false, botDms: true, reactionNotifications: 'all' });
    expect(events).toContainEqual({ type: 'preferences', preferences: { blurNsfw: false, adultConfirmed: false, botDms: true, reactionNotifications: 'all' } });
    expect((await api.get(ann, '/preferences')).body).toEqual({ blurNsfw: false, adultConfirmed: false, botDms: true, reactionNotifications: 'all' });
    expect((await api.get(bob, '/preferences')).body).toEqual({ blurNsfw: true, adultConfirmed: false, botDms: true, reactionNotifications: 'all' });

    expect((await api.put(ann, '/preferences', { blurNsfw: true })).body).toEqual({ blurNsfw: true, adultConfirmed: false, botDms: true, reactionNotifications: 'all' });
  });

  it('refuses unknown or invalid ones', async () => {
    const ann = await makeUser();
    expect((await api.put(ann, '/preferences', { blurNsfw: 'no' })).status).toBe(400);
    expect((await api.put(ann, '/preferences', { somethingElse: true })).status).toBe(400);
    expect((await api.put(ann, '/preferences', [true])).status).toBe(400);
    expect((await api.get(ann, '/preferences')).body).toEqual({ blurNsfw: true, adultConfirmed: false, botDms: true, reactionNotifications: 'all' });
  });

  it('keeps "I am 18 or over" as just that answer, never a date or an age', async () => {
    const db = require('../db');
    const ann = await makeUser();
    expect((await api.put(ann, '/preferences', { adultConfirmed: '2001-01-01' })).status).toBe(400);
    expect((await api.put(ann, '/preferences', { adultConfirmed: 19 })).status).toBe(400);
    const res = await api.put(ann, '/preferences', { adultConfirmed: true });
    expect(res.body).toEqual({ blurNsfw: true, adultConfirmed: true, botDms: true, reactionNotifications: 'all' });
    const row = await db.get('SELECT preferences FROM users WHERE id = ?', [ann.id]);
    expect(JSON.parse(row.preferences)).toEqual({ adultConfirmed: true });
    // Taking it back is allowed too (Settings → Content).
    expect((await api.put(ann, '/preferences', { adultConfirmed: false })).body).toEqual({ blurNsfw: true, adultConfirmed: false, botDms: true, reactionNotifications: 'all' });
  });
});
