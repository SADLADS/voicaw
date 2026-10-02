import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'dict-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-dict-123';
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

describe('the spellcheck dictionary', () => {
  it('is empty at first, saved per account, and sent to your other devices', async () => {
    const [ann, bob] = [await makeUser(), await makeUser()];
    expect((await api.get(ann, '/dictionary')).body).toEqual({ dictionary: null, version: 0 });
    expect((await request(app).get('/api/dictionary')).status).toBe(401);

    const events = connect(ann);
    const res = await api.put(ann, '/dictionary', { dictionary: 'v1.AAAA', version: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dictionary: 'v1.AAAA', version: 1 });
    expect(events).toContainEqual({ type: 'dictionary', dictionary: 'v1.AAAA', version: 1 });
    expect((await api.get(ann, '/dictionary')).body).toEqual({ dictionary: 'v1.AAAA', version: 1 });
    expect((await api.get(bob, '/dictionary')).body).toEqual({ dictionary: null, version: 0 });
  });

  it('refuses a save made from an older version, with the newer one', async () => {
    const ann = await makeUser();
    await api.put(ann, '/dictionary', { dictionary: 'v1.AAAA', version: 0 });
    const stale = await api.put(ann, '/dictionary', { dictionary: 'v1.BBBB', version: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ dictionary: 'v1.AAAA', version: 1 });
    expect((await api.put(ann, '/dictionary', { dictionary: 'v1.BBBB', version: 1 })).body.version).toBe(2);
  });

  it('only takes an envelope of a sane size', async () => {
    const ann = await makeUser();
    for (const body of [
      { dictionary: 'plain words', version: 0 },
      { dictionary: 'v1.AAAA', version: -1 },
      { dictionary: 'v1.AAAA', version: '0' },
      { dictionary: `v1.${'A'.repeat(70000)}`, version: 0 },
      { version: 0 },
    ]) {
      expect((await api.put(ann, '/dictionary', body)).status).toBe(400);
    }
  });
});
