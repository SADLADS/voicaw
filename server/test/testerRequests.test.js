import './helpers/mockS3.js';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');
const clients = app.locals.clients;

const PASSWORD = 'pw-tester-123';
let count = 0;
async function makeUser({ admin = false } = {}) {
  const username = `tester-${++count}`;
  const { response } = await registerUser(app, request, username, PASSWORD);
  if (admin) await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [response.body.id]);
  const login = await loginUser(app, request, username, PASSWORD);
  return { id: response.body.id, token: login.response.body.token };
}
const authed = (u) => ({ Authorization: `Bearer ${u.token}` });
const apply = (body) => request(app).post('/api/tester-requests').send(body);

let mod;
let ann;
beforeAll(async () => {
  mod = await makeUser({ admin: true });
  ann = await makeUser();
});

describe('Android tester requests', () => {
  it('takes a request from anyone and shows it to admins only', async () => {
    const events = [];
    clients.set(String(mod.id), [{ readyState: 1, send: (m) => events.push(JSON.parse(m)) }]);

    const res = await apply({ email: '  Pal.One@Gmail.com ', name: 'Pal', note: 'Pixel 7' });
    expect(res.status).toBe(201);
    expect(events).toContainEqual({ type: 'tester_requests' });

    const list = await request(app).get('/api/admin/tester-requests').set(authed(mod));
    expect(list.body.testers).toEqual([
      expect.objectContaining({ email: 'pal.one@gmail.com', name: 'Pal', note: 'Pixel 7', added_at: null }),
    ]);
    expect((await request(app).get('/api/admin/tester-requests').set(authed(ann))).status).toBe(403);
    expect((await request(app).get('/api/admin/tester-requests')).status).toBe(401);
    clients.delete(String(mod.id));
  });

  it('updates a repeated request instead of adding another', async () => {
    await apply({ email: 'pal.one@gmail.com', note: 'Pixel 8 now' });
    const rows = await db.all("SELECT * FROM tester_requests WHERE email = 'pal.one@gmail.com'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: null, note: 'Pixel 8 now' });
  });

  it('refuses bad input, and keeps nothing from a bot filling the hidden field', async () => {
    expect((await apply({ email: 'not an email' })).status).toBe(400);
    expect((await apply({})).status).toBe(400);
    expect((await apply({ email: 'a@b.co', note: 'x'.repeat(501) })).status).toBe(400);
    expect((await apply({ email: 'a@b.co', name: 5 })).status).toBe(400);

    expect((await apply({ email: 'bot@spam.example', website: 'http://spam' })).status).toBe(201);
    expect(await db.get("SELECT id FROM tester_requests WHERE email = 'bot@spam.example'")).toBeUndefined();
  });

  it('lets admins mark a request added (listed after the waiting ones) and remove it', async () => {
    await apply({ email: 'second@gmail.com' });
    const { id } = await db.get("SELECT id FROM tester_requests WHERE email = 'pal.one@gmail.com'");

    const added = await request(app).put(`/api/admin/tester-requests/${id}`).set(authed(mod)).send({ added: true });
    expect(added.status).toBe(200);
    expect(added.body.testers.map((r) => r.email)).toEqual(['second@gmail.com', 'pal.one@gmail.com']);
    expect(added.body.testers[1].added_at).toEqual(expect.any(Number));
    expect((await request(app).put(`/api/admin/tester-requests/${id}`).set(authed(ann)).send({ added: true })).status).toBe(403);
    expect((await request(app).put(`/api/admin/tester-requests/${id}`).set(authed(mod)).send({ added: 'yes' })).status).toBe(400);

    const removed = await request(app).delete(`/api/admin/tester-requests/${id}`).set(authed(mod));
    expect(removed.body.testers.map((r) => r.email)).toEqual(['second@gmail.com']);
    expect((await request(app).delete(`/api/admin/tester-requests/${id}`).set(authed(mod))).status).toBe(404);
    // Removed ones can't be marked any more.
    expect((await request(app).put(`/api/admin/tester-requests/${id}`).set(authed(mod)).send({ added: false })).status).toBe(404);
  });

  it('keeps removed requests in a history, which admins can page through and delete from', async () => {
    const history = (query = '', user = mod) => request(app).get(`/api/admin/tester-requests/history${query}`).set(authed(user));
    expect((await history('', ann)).status).toBe(403);
    const { body } = await history();
    expect(body.more).toBe(false);
    expect(body.history).toEqual([
      expect.objectContaining({ email: 'pal.one@gmail.com', added_at: expect.any(Number), removed_at: expect.any(Number) }),
    ]);

    const { id } = await db.get("SELECT id FROM tester_requests WHERE email = 'second@gmail.com'");
    await request(app).delete(`/api/admin/tester-requests/${id}`).set(authed(mod));
    const both = (await history()).body.history;
    expect(both).toHaveLength(2);
    const rest = (await history(`?before=${both[0].removed_at}:${both[0].id}`)).body.history;
    expect(rest.map((r) => r.id)).toEqual([both[1].id]);
    expect((await history('?before=x')).status).toBe(400);

    expect((await request(app).delete(`/api/admin/tester-requests/history/${id}`).set(authed(ann))).status).toBe(403);
    expect((await request(app).delete(`/api/admin/tester-requests/history/${id}`).set(authed(mod))).status).toBe(200);
    expect(await db.get('SELECT id FROM tester_requests WHERE id = ?', [id])).toBeUndefined();
    expect((await request(app).delete(`/api/admin/tester-requests/history/${id}`).set(authed(mod))).status).toBe(404);
  });

  it('asks again as new when a removed email asks again', async () => {
    expect((await apply({ email: 'pal.one@gmail.com', note: 'Again' })).status).toBe(201);
    const list = (await request(app).get('/api/admin/tester-requests').set(authed(mod))).body.testers;
    expect(list).toEqual([expect.objectContaining({ email: 'pal.one@gmail.com', note: 'Again', added_at: null })]);
    expect((await request(app).get('/api/admin/tester-requests/history').set(authed(mod))).body.history).toEqual([]);
    expect((await request(app).get('/api/admin/alerts').set(authed(mod))).body.testers).toBe(1);
  });

  it('forgets removed requests after a year', async () => {
    const { id } = await db.get("SELECT id FROM tester_requests WHERE email = 'pal.one@gmail.com'");
    await request(app).delete(`/api/admin/tester-requests/${id}`).set(authed(mod));
    expect((await request(app).get('/api/admin/alerts').set(authed(mod))).body.testers).toBe(0);
    await db.run('UPDATE tester_requests SET removed_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000) - 366 * 24 * 60 * 60, id]);
    expect((await request(app).get('/api/admin/tester-requests/history').set(authed(mod))).body.history).toEqual([]);
    expect(await db.get('SELECT id FROM tester_requests WHERE id = ?', [id])).toBeUndefined();
  });
});
