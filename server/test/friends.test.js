import './helpers/mockS3.js';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');
const clients = app.locals.clients;

let count = 0;
async function makeUser() {
  const username = `friend-${++count}`;
  const { response } = await registerUser(app, request, username, 'pw-friend-123');
  const login = await loginUser(app, request, username, 'pw-friend-123');
  return { id: response.body.id, username, token: login.response.body.token };
}
const authed = (u) => ({ Authorization: `Bearer ${u.token}` });
const api = {
  get: (u, url) => request(app).get(`/api${url}`).set(authed(u)),
  put: (u, url, body = {}) => request(app).put(`/api${url}`).set(authed(u)).send(body),
  post: (u, url, body = {}) => request(app).post(`/api${url}`).set(authed(u)).send(body),
  delete: (u, url) => request(app).delete(`/api${url}`).set(authed(u)),
};
function listen(user) {
  const events = [];
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), { readyState: 1, send: (m) => events.push(JSON.parse(m)) }]);
  return events;
}
const ids = (list) => list.map((r) => r.id);

let ann;
let bob;
beforeEach(async () => {
  ann = await makeUser();
  bob = await makeUser();
});

describe('friends', () => {
  it('starts with none, and needs a login', async () => {
    expect((await api.get(ann, '/friends')).body).toEqual({ friends: [], incoming: [], outgoing: [], admin: false });
    expect((await request(app).get('/api/friends')).status).toBe(401);
  });

  it('sends, accepts and removes a request, telling both people', async () => {
    const annEvents = listen(ann);
    const bobEvents = listen(bob);
    const sent = await api.put(ann, `/friends/${bob.id}`);
    expect(sent.body).toMatchObject({ id: bob.id, result: 'requested', friends: [], incoming: [] });
    expect(ids(sent.body.outgoing)).toEqual([bob.id]);
    expect(ids(bobEvents.find((e) => e.type === 'friends').incoming)).toEqual([ann.id]);
    // Asking again changes nothing.
    expect((await api.put(ann, `/friends/${bob.id}`)).body.result).toBe('requested');

    const accepted = await api.put(bob, `/friends/${ann.id}`);
    expect(accepted.body).toMatchObject({ id: ann.id, result: 'accepted', incoming: [], outgoing: [] });
    expect(ids(accepted.body.friends)).toEqual([ann.id]);
    expect(ids(annEvents.at(-1).friends)).toEqual([bob.id]);
    expect(annEvents.at(-1).outgoing).toEqual([]);
    expect((await api.put(ann, `/friends/${bob.id}`)).body.result).toBe('friends');

    const removed = await api.delete(ann, `/friends/${bob.id}`);
    expect(removed.body).toMatchObject({ result: 'removed', friends: [] });
    expect((await api.get(bob, '/friends')).body.friends).toEqual([]);
    expect((await api.delete(ann, `/friends/${bob.id}`)).body.result).toBe('none');
  });

  it('declines and cancels requests', async () => {
    await api.put(ann, `/friends/${bob.id}`);
    expect((await api.delete(bob, `/friends/${ann.id}`)).body.incoming).toEqual([]);
    expect((await api.get(ann, '/friends')).body.outgoing).toEqual([]);
    await api.put(ann, `/friends/${bob.id}`);
    expect((await api.delete(ann, `/friends/${bob.id}`)).body.outgoing).toEqual([]);
    expect((await api.get(bob, '/friends')).body.incoming).toEqual([]);
  });

  it('adds by username, in any capitals', async () => {
    const res = await api.post(ann, '/friends', { username: bob.username.toUpperCase() });
    expect(res.body).toMatchObject({ id: bob.id, result: 'requested' });
    expect((await api.post(ann, '/friends', { username: 'nobody-at-all' })).body.code).toBe('not_found');
    expect((await api.post(ann, '/friends', { username: '' })).status).toBe(400);
    expect((await api.post(ann, '/friends', { username: ann.username })).body.code).toBe('self');
  });

  it("can't add bots, accounts waiting for approval, deleted accounts or yourself", async () => {
    const cal = await makeUser();
    await db.run('UPDATE users SET pending = 1 WHERE id = ?', [cal.id]);
    expect((await api.put(ann, `/friends/${cal.id}`)).status).toBe(404);
    await db.run('UPDATE users SET pending = 0, bot = 1 WHERE id = ?', [cal.id]);
    expect((await api.put(ann, `/friends/${cal.id}`)).status).toBe(404);
    await db.run('UPDATE users SET bot = 0, deleted_at = 1 WHERE id = ?', [cal.id]);
    expect((await api.put(ann, `/friends/${cal.id}`)).status).toBe(404);
    expect((await api.put(ann, `/friends/${ann.id}`)).status).toBe(400);
    expect((await api.put(ann, '/friends/abc')).status).toBe(400);
  });

  it('blocking ends a friendship and stops requests either way', async () => {
    await api.put(ann, `/friends/${bob.id}`);
    await api.put(bob, `/friends/${ann.id}`);
    const bobEvents = listen(bob);
    await api.put(ann, `/blocks/${bob.id}`);
    expect((await api.get(ann, '/friends')).body.friends).toEqual([]);
    expect(bobEvents.find((e) => e.type === 'friends').friends).toEqual([]);
    const refused = await api.put(bob, `/friends/${ann.id}`);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('blocked');
    expect((await api.put(ann, `/friends/${bob.id}`)).status).toBe(403);
  });

  it('tells admins they are', async () => {
    await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [ann.id]);
    expect((await api.get(ann, '/friends')).body.admin).toBe(true);
  });

  it('goes with a deleted account', async () => {
    await api.put(ann, `/friends/${bob.id}`);
    await api.put(bob, `/friends/${ann.id}`);
    const cal = await makeUser();
    await api.put(cal, `/friends/${ann.id}`);
    // Straight through accounts.js (the route also wants the password).
    const accounts = require('../accounts');
    await accounts.deleteAccount(ann.id, await accounts.checkDeletion(ann.id));
    expect((await api.get(bob, '/friends')).body.friends).toEqual([]);
    expect((await api.get(cal, '/friends')).body.outgoing).toEqual([]);
  });
});

describe('migration 14', () => {
  it('makes everyone friends with everyone else, except bots, pending, deleted and blocked accounts', async () => {
    const [cal, dee, eve, fay, gus] = [await makeUser(), await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    await db.run('UPDATE users SET bot = 1 WHERE id = ?', [cal.id]);
    await db.run('UPDATE users SET pending = 1 WHERE id = ?', [dee.id]);
    await db.run('UPDATE users SET deleted_at = 1 WHERE id = ?', [eve.id]);
    await api.put(fay, `/blocks/${gus.id}`);
    db.befriendEveryone();
    const friendsOf = async (u) => ids((await api.get(u, '/friends')).body.friends);
    expect(await friendsOf(ann)).toEqual(expect.arrayContaining([bob.id, fay.id, gus.id]));
    expect(await friendsOf(ann)).not.toEqual(expect.arrayContaining([cal.id]));
    for (const left of [cal, dee, eve]) expect(await friendsOf(ann)).not.toContain(left.id);
    expect(await friendsOf(fay)).not.toContain(gus.id);
    expect(await friendsOf(gus)).not.toContain(fay.id);
  });
});
