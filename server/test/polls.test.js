import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

// Polls are messages (`poll:v1:` + JSON) and their votes reactions (`poll:<option id>`, client
// utils/pollMarkup.js); the server only reads them in guilds. Everywhere, their authors register
// when they close, and a "poll ended" row is posted then (pollTimers.js).
const app = require('../index.js');
const { announceDue } = require('../pollTimers.js');
const clients = app.locals.clients;

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}
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
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};
const db = require('../db.js');
const now = () => Math.floor(Date.now() / 1000);
const pollText = (extra = {}) => `poll:v1:${JSON.stringify({ q: 'When?', multi: false, d: 3600, ...extra, o: [{ id: 'aaaa1111', t: 'Now' }] })}`;

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

  it('takes no votes (and keeps them) once the poll has run its time', async () => {
    const { owner, bob, general } = await setUp();
    const poll = (await api.post(owner, `/channels/${general.id}/messages`, { content: pollText() })).body;
    const vote = await api.post(bob, `/guild-messages/${poll.id}/reactions`, { emoji: 'poll:aaaa1111' });
    expect(vote.status).toBe(201);
    // An hour and a bit later.
    await db.run('UPDATE guild_messages SET timestamp = ? WHERE id = ?', [now() - 3700, poll.id]);
    expect((await api.post(owner, `/guild-messages/${poll.id}/reactions`, { emoji: 'poll:aaaa1111' })).body.error).toBe('This poll has closed');
    expect((await api.delete(bob, `/guild-reactions/${vote.body.id}`)).status).toBe(403);
    // Ordinary reactions still come and go.
    expect((await api.post(bob, `/guild-messages/${poll.id}/reactions`, { emoji: '👍' })).status).toBe(201);
    // And it can't be edited any more.
    expect((await api.put(owner, `/guild-messages/${poll.id}`, { content: pollText({ q: 'Later?' }) })).status).toBe(403);
  });

  it('lets the author end it early, but not reopen it or change its duration', async () => {
    const { owner, bob, general } = await setUp();
    const poll = (await api.post(owner, `/channels/${general.id}/messages`, { content: pollText() })).body;
    const edit = (content) => api.put(owner, `/guild-messages/${poll.id}`, { content });
    expect((await edit(pollText({ d: 7200 }))).status).toBe(403);
    expect((await edit(pollText({ multi: true }))).status).toBe(403);
    expect((await edit('not a poll any more')).status).toBe(403);
    expect((await edit(pollText({ x: now() + 3000 }))).status).toBe(403); // not "now"
    expect((await edit(pollText({ q: 'Renamed?' }))).status).toBe(200);
    expect((await edit(pollText({ x: now() }))).status).toBe(200);
    expect((await api.post(bob, `/guild-messages/${poll.id}/reactions`, { emoji: 'poll:aaaa1111' })).status).toBe(403);
    expect((await edit(pollText())).status).toBe(403); // closed for good
  });
});

// In a DM the server only sees ciphertext; it doesn't need anything else.
describe('DM polls', () => {
  const REACTION = 'v1.' + 'A'.repeat(123) + '=';

  it('posts a "poll ended" row when the poll is due, with the poll and its votes', async () => {
    const [ann, bob] = [await makeUser('dmpoll'), await makeUser('dmpoll')];
    const poll = (await api.post(ann, '/dm-send', { recipient_id: bob.id, content: 'v1.encrypted-poll' })).body;
    expect((await api.post(bob, `/polls/dm/${poll.id}/timer`, { duration: 60 })).status).toBe(403);
    expect((await api.post(ann, `/polls/dm/${poll.id}/timer`, { duration: 20 * 86400 })).status).toBe(400);
    expect((await api.post(ann, `/polls/dm/${poll.id}/timer`, { duration: 60 })).body.ends_at).toBe(poll.timestamp + 60);
    expect((await api.post(ann, `/polls/dm/${poll.id}/timer`, { duration: 5 })).status).toBe(409);
    const vote = (await api.post(bob, '/dm-reactions', { messageId: poll.id, content: REACTION })).body;
    await api.post(bob, `/dm-mark-read/${ann.id}`);

    const bobEvents = listen(bob);
    await announceDue();
    expect(bobEvents.some((e) => e.type === 'new_dm')).toBe(false); // not yet
    await db.run("UPDATE poll_timers SET ends_at = ends_at - 61 WHERE kind = 'dm' AND message_id = ?", [poll.id]);
    await announceDue();
    await announceDue(); // only once
    const rows = bobEvents.filter((e) => e.type === 'new_dm').map((e) => e.message);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      system: 'poll_end', sender_id: ann.id, recipient_id: bob.id, parent_message_id: poll.id,
      parent_content: 'v1.encrypted-poll', content: '',
    });
    expect(rows[0].poll_reactions.map((r) => r.id)).toEqual([vote.id]);
    const history = (await api.get(bob, `/dm-messages/${ann.id}`)).body;
    expect(history.at(-1)).toMatchObject({ id: rows[0].id, system: 'poll_end' });
    expect((await api.get(bob, '/dm-get-unread')).body).toMatchObject([{ from_user_id: ann.id, count: 1 }]);
    // Ending it now does nothing more; the row can't be edited.
    expect((await api.post(ann, `/polls/dm/${poll.id}/end`)).status).toBe(409);
    expect((await api.put(ann, `/update-message/${rows[0].id}`, { content: 'v1.x' })).status).toBe(403);
  });

  it('ends a poll at once, and deleting the poll deletes its row', async () => {
    const [ann, bob] = [await makeUser('dmpoll'), await makeUser('dmpoll')];
    const poll = (await api.post(ann, '/dm-send', { recipient_id: bob.id, content: 'v1.encrypted-poll' })).body;
    await api.post(ann, `/polls/dm/${poll.id}/timer`, { duration: 3600 });
    expect((await api.post(bob, `/polls/dm/${poll.id}/end`)).status).toBe(403);
    const bobEvents = listen(bob);
    const { messageId } = (await api.post(ann, `/polls/dm/${poll.id}/end`)).body;
    expect(bobEvents.find((e) => e.type === 'new_dm').message.id).toBe(messageId);
    await request(app).delete(`/api/messages/${poll.id}`).set(authed(ann));
    expect(bobEvents.filter((e) => e.type === 'delete_dm').map((e) => e.messageId)).toEqual([poll.id, messageId]);
    expect((await api.get(bob, `/dm-messages/${ann.id}`)).body).toEqual([]);
    expect(await db.get("SELECT * FROM poll_timers WHERE kind = 'dm' AND message_id = ?", [poll.id])).toBeUndefined();
  });
});

describe('guild poll rows', () => {
  it('checks the duration against the poll, and needs the poll ended before its row', async () => {
    const { owner, bob, general } = await setUp();
    const poll = (await api.post(owner, `/channels/${general.id}/messages`, { content: pollText() })).body;
    const plain = (await api.post(owner, `/channels/${general.id}/messages`, { content: 'hi' })).body;
    expect((await api.post(owner, `/polls/guild/${plain.id}/timer`, { duration: 3600 })).status).toBe(400);
    expect((await api.post(owner, `/polls/guild/${poll.id}/timer`, { duration: 60 })).status).toBe(400);
    expect((await api.post(owner, `/polls/guild/${poll.id}/timer`, { duration: 3600 })).status).toBe(200);
    expect((await api.post(owner, `/polls/guild/${poll.id}/end`)).status).toBe(400); // not ended in its text
    await api.put(owner, `/guild-messages/${poll.id}`, { content: pollText({ x: now() }) });
    const bobEvents = listen(bob);
    const { messageId } = (await api.post(owner, `/polls/guild/${poll.id}/end`)).body;
    const row = bobEvents.find((e) => e.type === 'guild_message_new').message;
    expect(row).toMatchObject({ id: messageId, system: 'poll_end', parent_message_id: poll.id, poll_reactions: [] });
    expect(row.parent_content).toContain('poll:v1:');
  });
});
