import './helpers/mockS3.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const history = require('../activityHistory.js');

let userCount = 0;
async function makeUser() {
  const username = `profile-tabs-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-profile-1');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-profile-1');
  return { id: regRes.body.id, username, token: loginRes.body.token };
}
const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (u, url) => request(app).get(`/api${url}`).set(authed(u)),
  put: (u, url, body = {}) => request(app).put(`/api${url}`).set(authed(u)).send(body),
  post: (u, url, body = {}) => request(app).post(`/api${url}`).set(authed(u)).send(body),
};
const befriend = async (a, b) => {
  await api.put(a, `/friends/${b.id}`);
  await api.put(b, `/friends/${a.id}`);
};
const profile = async (viewer, user) => (await api.get(viewer, `/users/${user.id}/profile`)).body;

// Moves the clock to `seconds` (unix s).
let clock;
const at = (seconds) => {
  clock?.mockRestore();
  clock = vi.spyOn(Date, 'now').mockReturnValue(seconds * 1000);
};
afterEach(() => {
  clock?.mockRestore();
  clock = null;
});
const playing = (...names) => names.map((name) => ({ name, type: 0 }));

describe('activity history', () => {
  it('keeps play sessions of named games only, joins a quick restart, and sums them per game', async () => {
    const ann = await makeUser();
    const t = Math.floor(Date.now() / 1000);
    at(t);
    await history.record(ann.id, [...playing('Hades'), { name: 'Some song', type: 2 }, { name: null, type: 0 }]);
    at(t + 600);
    await history.record(ann.id, []);
    // Back within 5 minutes: the same session.
    at(t + 700);
    await history.record(ann.id, playing('Hades', 'Celeste'));
    at(t + 1000);
    await history.tick();
    const games = await history.historyOf(ann.id);
    expect(games).toEqual([
      { name: 'Hades', seconds: 1000, lastPlayed: t + 1000, sessions: 1, playing: true },
      { name: 'Celeste', seconds: 300, lastPlayed: t + 1000, sessions: 1, playing: true },
    ]);
    // Later on: a new session.
    at(t + 2000);
    await history.record(ann.id, []);
    at(t + 5000);
    await history.record(ann.id, playing('Hades'));
    at(t + 5100);
    await history.record(ann.id, []);
    const hades = (await history.historyOf(ann.id)).find((g) => g.name === 'Hades');
    expect(hades).toMatchObject({ seconds: 2000 + 100, sessions: 2, playing: false });
  });

  it("forgets what's over 30 days old, and never records bots or people who turned it off", async () => {
    const bea = await makeUser();
    const t = Math.floor(Date.now() / 1000);
    at(t - 31 * 86400);
    await history.record(bea.id, playing('Old game'));
    await history.record(bea.id, []);
    at(t);
    await history.prune();
    expect(await history.historyOf(bea.id)).toEqual([]);

    expect((await api.put(bea, '/preferences', { showActivity: false })).body.showActivity).toBe(false);
    await history.record(bea.id, playing('Hidden'));
    await history.record(bea.id, []);
    expect((await db.get('SELECT COUNT(*) AS n FROM activity_sessions WHERE user_id = ?', [bea.id])).n).toBe(0);
  });

  it('deletes the history when Show my activity is turned off', async () => {
    const cal = await makeUser();
    await history.record(cal.id, playing('Celeste'));
    await history.record(cal.id, []);
    expect(await history.historyOf(cal.id)).toHaveLength(1);
    await api.put(cal, '/preferences', { showActivity: false });
    expect((await db.get('SELECT COUNT(*) AS n FROM activity_sessions WHERE user_id = ?', [cal.id])).n).toBe(0);
  });
});

describe('GET /users/:id/profile', () => {
  it('lists their games, the friends and guilds you share, and nothing they hide', async () => {
    const ann = await makeUser();
    const bob = await makeUser();
    const cal = await makeUser();
    const dan = await makeUser();
    await befriend(ann, bob);
    await befriend(ann, cal);
    await befriend(bob, cal);
    await befriend(ann, dan); // not Bob's friend
    const guild = (await api.post(ann, '/guilds', { name: 'Shared' })).body;
    await api.post(ann, '/guilds', { name: 'Only Ann' });
    const invite = (await api.post(ann, `/guilds/${guild.id}/invites`)).body;
    await api.post(bob, `/invites/${invite.code}`);
    await history.record(ann.id, playing('Hades'));
    await history.record(ann.id, []);

    const seen = await profile(bob, ann);
    expect(seen.activity.map((g) => g.name)).toEqual(['Hades']);
    expect(seen.mutualFriends.map((u) => u.id)).toEqual([cal.id]);
    expect(seen.mutualFriends[0]).toMatchObject({ username: cal.username, avatar: null, banner: null });
    expect(seen.mutualGuilds).toEqual([{ id: guild.id, name: 'Shared', icon_version: expect.anything() }]);
    expect(seen.memberSince).toEqual(expect.any(Number));
    expect(seen.hidden).toBeUndefined();

    await api.put(ann, '/preferences', { showMutualFriends: false, showMutualGuilds: false });
    const hidden = await profile(bob, ann);
    expect(hidden).toMatchObject({ mutualFriends: null, mutualGuilds: null });
    expect(hidden.activity).toHaveLength(1);
    await api.put(ann, '/preferences', { showActivity: false });
    expect((await profile(bob, ann)).activity).toBe(null);

    // Your own: your activity, and which are hidden.
    expect(await profile(ann, ann)).toMatchObject({
      activity: [], mutualFriends: null, mutualGuilds: null, hidden: { activity: true, mutualFriends: true, mutualGuilds: true },
    });
  });

  it('shows nothing between people who blocked each other, and 404s for no one', async () => {
    const eve = await makeUser();
    const fin = await makeUser();
    await befriend(eve, fin);
    expect((await api.put(eve, `/blocks/${fin.id}`)).status).toBeLessThan(300);
    expect(await profile(fin, eve)).toMatchObject({ activity: null, mutualFriends: null, mutualGuilds: null });
    expect((await api.get(fin, '/users/999999/profile')).status).toBe(404);
    expect((await request(app).get(`/api/users/${eve.id}/profile`)).status).toBe(401);
  });
});
