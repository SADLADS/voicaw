import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

// Polls are messages (`poll:v1:` + JSON) and their votes reactions (`poll:<option id>`, client
// utils/pollMarkup.js); the server only treats them specially in guilds.
const app = require('../index.js');
const { PERMISSIONS: P } = require('../permissions.js');

let userCount = 0;
async function makeUser(prefix = 'poll-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-polls-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};

const POLL = `poll:v1:${JSON.stringify({ q: 'Lunch?', multi: false, o: [{ id: 'aaaa1111', t: 'Pizza' }, { id: 'bbbb2222', t: 'Soup' }] })}`;

async function setUp() {
  const owner = await makeUser('poll-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Polls' })).body;
  const bob = await makeUser('poll-member');
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  await api.post(bob, `/invites/${invite.body.code}`);
  return { owner, bob, guild, general: guild.channels[0] };
}

describe('guild polls', () => {
  it('lets members vote without Add Reactions, but not react', async () => {
    const { owner, bob, guild, general } = await setUp();
    await api.put(owner, `/guilds/${guild.id}/channels/${general.id}/overrides/member/${bob.id}`, { deny: P.ADD_REACTIONS });
    const poll = (await api.post(owner, `/channels/${general.id}/messages`, { content: POLL })).body;
    const plain = (await api.post(owner, `/channels/${general.id}/messages`, { content: 'not a poll' })).body;

    const vote = await api.post(bob, `/guild-messages/${poll.id}/reactions`, { emoji: 'poll:aaaa1111' });
    expect(vote.status).toBe(201);
    expect(vote.body).toMatchObject({ user_id: bob.id, emoji: 'poll:aaaa1111' });
    expect((await api.post(bob, `/guild-messages/${poll.id}/reactions`, { emoji: '👍' })).status).toBe(403);
    // Only on a poll, and only in a vote's shape.
    expect((await api.post(bob, `/guild-messages/${plain.id}/reactions`, { emoji: 'poll:aaaa1111' })).status).toBe(403);
    expect((await api.post(bob, `/guild-messages/${poll.id}/reactions`, { emoji: 'poll:x' })).status).toBe(403);
  });

  it('pushes the question, not the JSON', async () => {
    const { owner, bob, guild, general } = await setUp();
    await api.put(bob, `/guilds/${guild.id}/notifications`, { level: 'all' });
    await api.post(bob, '/save-subscription', { subscription: { endpoint: `https://push.test/${bob.username}`, keys: { p256dh: 'p', auth: 'a' } } });
    const since = sentPushes.length;
    expect((await api.post(owner, `/channels/${general.id}/messages`, { content: POLL })).status).toBe(201);
    await waitForPushes(1000, since, 300);
    const push = sentPushes.slice(since).find((p) => p.endpoint === `https://push.test/${bob.username}`);
    expect(push.payload.body).toBe('📊 Poll: Lunch?');
  });
});
