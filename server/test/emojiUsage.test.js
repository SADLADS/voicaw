import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const clients = app.locals.clients;
const { checkDeletion, deleteAccount } = require('../accounts');

let userCount = 0;
async function makeUser(prefix = 'emoji-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-emoji-123';
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

describe('emoji usage', () => {
  it('is empty at first, saved per account, and sent to your other devices', async () => {
    const [ann, bob] = [await makeUser(), await makeUser()];
    expect((await api.get(ann, '/emoji-usage')).body).toEqual({ emojiUsage: null, version: 0 });
    expect((await request(app).get('/api/emoji-usage')).status).toBe(401);

    const events = connect(ann);
    const res = await api.put(ann, '/emoji-usage', { emojiUsage: 'v1.AAAA', version: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ emojiUsage: 'v1.AAAA', version: 1 });
    expect(events).toContainEqual({ type: 'emoji_usage', emojiUsage: 'v1.AAAA', version: 1 });
    expect((await api.get(ann, '/emoji-usage')).body).toEqual({ emojiUsage: 'v1.AAAA', version: 1 });
    expect((await api.get(bob, '/emoji-usage')).body).toEqual({ emojiUsage: null, version: 0 });
  });

  it('refuses a save made from an older version, with the newer one', async () => {
    const ann = await makeUser();
    await api.put(ann, '/emoji-usage', { emojiUsage: 'v1.AAAA', version: 0 });
    const stale = await api.put(ann, '/emoji-usage', { emojiUsage: 'v1.BBBB', version: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ emojiUsage: 'v1.AAAA', version: 1 });
    expect((await api.put(ann, '/emoji-usage', { emojiUsage: 'v1.BBBB', version: 1 })).body.version).toBe(2);
  });

  it('only takes an envelope of a sane size', async () => {
    const ann = await makeUser();
    for (const body of [
      { emojiUsage: '{"grinning":3}', version: 0 },
      { emojiUsage: 'v1.AAAA', version: -1 },
      { emojiUsage: `v1.${'A'.repeat(12000)}`, version: 0 },
      { version: 0 },
    ]) {
      expect((await api.put(ann, '/emoji-usage', body)).status).toBe(400);
    }
    // The client's size (8 KiB padded, encrypted) fits.
    expect((await api.put(ann, '/emoji-usage', { emojiUsage: `v1.${'A'.repeat(10960)}`, version: 0 })).status).toBe(200);
  });

  it('goes with the account', async () => {
    const ann = await makeUser();
    await api.put(ann, '/emoji-usage', { emojiUsage: 'v1.AAAA', version: 0 });
    await deleteAccount(ann.id, await checkDeletion(ann.id));
    const db = require('../db');
    expect(await db.get('SELECT emoji_usage, emoji_usage_version FROM users WHERE id = ?', [ann.id]))
      .toEqual({ emoji_usage: null, emoji_usage_version: 0 });
  });
});
