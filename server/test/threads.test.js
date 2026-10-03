import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { AUTO_ARCHIVE_SECONDS } = require('../threads.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'thread-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-threads-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

function connect(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now() } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

// A guild with an owner and two members, and its #general.
async function setUp() {
  const owner = await makeUser('t-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Threads' })).body;
  const members = [];
  for (let i = 0; i < 2; i++) {
    const user = await makeUser('t-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  return { owner, members, guild, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

const say = (user, channelId, content) => api.post(user, `/channels/${channelId}/messages`, { content });
const layout = async (user, guild) => (await api.get(user, `/guilds/${guild.id}`)).body;
const unreadFor = async (user, channelId) => (await api.get(user, '/guild-unread')).body.find((u) => u.channel_id === channelId);

describe('threads', () => {
  it('starts a thread from a message, shown on the message and in its starter\'s channel list', async () => {
    const { owner, members: [bob], guild, general } = await setUp();
    const message = (await say(bob, general.id, 'shall we plan the trip?')).body;
    const bobEvents = connect(bob);

    const res = await api.post(owner, `/channels/${general.id}/threads`, { name: 'Trip planning', messageId: message.id });
    expect(res.status).toBe(201);
    const thread = res.body;
    expect(thread).toMatchObject({
      parent_id: general.id, name: 'Trip planning', owner_id: owner.id, starter_message_id: message.id,
      archived: false, joined: true, message_count: 0,
    });
    expect(bobEvents.some((e) => e.type === 'guild_thread_update' && e.thread.id === thread.id)).toBe(true);

    // Not a channel in the list, but in `threads`, joined for its starter only.
    const ownerLayout = await layout(owner, guild);
    expect(ownerLayout.channels.map((c) => c.id)).not.toContain(thread.id);
    expect(ownerLayout.threads).toEqual([expect.objectContaining({ id: thread.id, joined: true })]);
    expect((await layout(bob, guild)).threads).toEqual([expect.objectContaining({ id: thread.id, joined: false })]);

    const page = (await api.get(bob, `/channels/${general.id}/messages`)).body;
    expect(page.find((m) => m.id === message.id).thread).toMatchObject({ id: thread.id, name: 'Trip planning' });

    const opened = (await api.get(bob, `/threads/${thread.id}`)).body;
    expect(opened.thread).toMatchObject({ id: thread.id, joined: false });
    expect(opened.starter).toMatchObject({ id: message.id, content: 'shall we plan the trip?' });

    expect((await api.post(bob, `/channels/${general.id}/threads`, { name: 'Again', messageId: message.id })).status).toBe(409);
    expect((await api.post(bob, `/channels/${general.id}/threads`, { name: ' ', messageId: message.id })).status).toBe(400);
    expect((await api.post(bob, `/channels/${general.id}/threads`, { name: 'x'.repeat(101) })).status).toBe(400);
  });

  it('a thread started on its own gets a "started a thread" row in the channel', async () => {
    const { owner, members: [bob], general } = await setUp();
    const thread = (await api.post(owner, `/channels/${general.id}/threads`, { name: 'Random ideas' })).body;
    const page = (await api.get(bob, `/channels/${general.id}/messages`)).body;
    const row = page.find((m) => m.id === thread.starter_message_id);
    expect(row).toMatchObject({ system: 'thread', content: 'Random ideas', sender_id: owner.id });
    expect(row.thread).toMatchObject({ id: thread.id });
    expect((await api.get(bob, `/threads/${thread.id}`)).body.starter).toBeNull();
    // Nobody can start a thread from a system row, nor from another channel's message.
    expect((await api.post(bob, `/channels/${general.id}/threads`, { name: 'x', messageId: row.id })).status).toBe(400);
  });

  it('messages in a thread: members join by posting or being mentioned, and only members get unread counts', async () => {
    const { owner, members: [bob, carol], general } = await setUp();
    const thread = (await api.post(owner, `/channels/${general.id}/threads`, { name: 'Side chat' })).body;
    const ownerEvents = connect(owner);

    const sent = await say(bob, thread.id, 'hello in here');
    expect(sent.status).toBe(201);
    expect(sent.body.channel_id).toBe(thread.id);
    const update = ownerEvents.filter((e) => e.type === 'guild_thread_update').at(-1);
    expect(update.thread).toMatchObject({ id: thread.id, message_count: 1 });
    expect((await api.get(bob, `/threads/${thread.id}`)).body.thread.joined).toBe(true);

    // Carol isn't a member: no unread count, until she's mentioned (which makes her one).
    expect(await unreadFor(carol, thread.id)).toBeUndefined();
    await say(bob, thread.id, `<@${carol.id}> have a look`);
    expect(await unreadFor(carol, thread.id)).toMatchObject({ count: 2, mentions: 1 });
    expect(await unreadFor(owner, thread.id)).toMatchObject({ count: 2 });
    // Thread messages don't count in the channel's own unread.
    expect(await unreadFor(owner, general.id)).toBeUndefined();

    // Leaving and joining.
    expect((await api.delete(carol, `/threads/${thread.id}/member`)).body.joined).toBe(false);
    expect(await unreadFor(carol, thread.id)).toBeUndefined();
    expect((await api.put(carol, `/threads/${thread.id}/member`)).body.joined).toBe(true);

    // Replies point inside the thread only.
    const outside = (await say(bob, general.id, 'out here')).body;
    expect((await api.post(bob, `/channels/${thread.id}/messages`, { content: 'x', replyTo: outside.id })).status).toBe(400);
    expect((await api.post(bob, `/channels/${thread.id}/messages`, { content: 'x', replyTo: sent.body.id })).status).toBe(201);
  });

  it('follows its channel\'s permissions, with Send Messages in Threads for posting', async () => {
    const { owner, members: [bob, carol], guild, general, everyone } = await setUp();
    const thread = (await api.post(owner, `/channels/${general.id}/threads`, { name: 'Perms' })).body;
    const override = (targetType, targetId, body) =>
      api.put(owner, `/guilds/${guild.id}/channels/${general.id}/overrides/${targetType}/${targetId}`, body);

    // Bob can't post in threads, but still in the channel.
    expect((await override('member', bob.id, { deny: P.SEND_MESSAGES_IN_THREADS })).status).toBe(200);
    expect((await say(bob, thread.id, 'nope')).status).toBe(403);
    expect((await say(bob, general.id, 'fine')).status).toBe(201);
    expect((await layout(bob, guild)).threads[0].my_permissions & P.SEND_MESSAGES).toBe(0);
    // Read-only channel, threads open: Bob posts in threads only.
    expect((await override('member', bob.id, { deny: P.SEND_MESSAGES, allow: P.SEND_MESSAGES_IN_THREADS })).status).toBe(200);
    expect((await say(bob, general.id, 'nope')).status).toBe(403);
    expect((await say(bob, thread.id, 'yes')).status).toBe(201);
    // Create Threads.
    expect((await override('member', bob.id, { deny: P.CREATE_THREADS })).status).toBe(200);
    expect((await api.post(bob, `/channels/${general.id}/threads`, { name: 'mine' })).status).toBe(403);

    // A private channel's threads are private too.
    expect((await override('role', everyone.id, { deny: P.VIEW_CHANNEL })).status).toBe(200);
    expect((await api.get(carol, `/threads/${thread.id}`)).status).toBe(404);
    expect((await say(carol, thread.id, 'hi')).status).toBe(404);
    expect((await layout(carol, guild)).threads).toEqual([]);

    // A thread has no overrides or channel settings of its own.
    expect((await api.put(owner, `/guilds/${guild.id}/channels/${thread.id}/overrides/member/${carol.id}`, { allow: P.VIEW_CHANNEL })).status).toBe(404);
    expect((await api.patch(owner, `/guilds/${guild.id}/channels/${thread.id}`, { name: 'renamed' })).status).toBe(404);
    expect((await api.post(owner, `/guilds/${guild.id}/channels/${thread.id}/clone`)).status).toBe(404);
  });

  it('renames and archives: its starter or Manage Messages; posting or anyone who can post unarchives', async () => {
    const { owner, members: [bob, carol], guild, general } = await setUp();
    const thread = (await api.post(bob, `/channels/${general.id}/threads`, { name: 'Bob\'s' })).body;

    expect((await api.patch(carol, `/threads/${thread.id}`, { name: 'Carol\'s' })).status).toBe(403);
    expect((await api.patch(bob, `/threads/${thread.id}`, { name: 'Bob\'s plan' })).body.name).toBe('Bob\'s plan');
    expect((await api.patch(owner, `/threads/${thread.id}`, { archived: true })).body.archived).toBe(true);
    expect((await layout(bob, guild)).threads).toEqual([]);
    expect((await api.get(bob, `/channels/${general.id}/threads`)).body).toEqual([expect.objectContaining({ id: thread.id, archived: true })]);

    // Posting brings it back.
    expect((await say(carol, thread.id, 'still going?')).status).toBe(201);
    expect((await api.get(carol, `/threads/${thread.id}`)).body.thread.archived).toBe(false);
    expect((await api.patch(carol, `/threads/${thread.id}`, { archived: true })).status).toBe(403);

    // A week without messages archives it; unarchiving starts the week again.
    await db.run('UPDATE guild_channels SET last_activity = ? WHERE id = ?', [Math.floor(Date.now() / 1000) - AUTO_ARCHIVE_SECONDS - 1, thread.id]);
    expect((await api.get(carol, `/threads/${thread.id}`)).body.thread.archived).toBe(true);
    expect((await api.patch(carol, `/threads/${thread.id}`, { archived: false })).body.archived).toBe(false);

    const entries = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body.entries;
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(['thread_create', 'thread_update']));
  });

  it('deleting a thread (Manage Messages) takes its messages and its "started a thread" row', async () => {
    const { owner, members: [bob], guild, general } = await setUp();
    const thread = (await api.post(bob, `/channels/${general.id}/threads`, { name: 'Doomed' })).body;
    await say(bob, thread.id, 'bye');
    expect((await api.delete(bob, `/threads/${thread.id}`)).status).toBe(403);
    const bobEvents = connect(bob);
    expect((await api.delete(owner, `/threads/${thread.id}`)).status).toBe(200);
    expect(bobEvents.some((e) => e.type === 'guild_thread_delete' && e.threadId === thread.id)).toBe(true);
    expect(bobEvents.some((e) => e.type === 'guild_message_delete' && e.messageId === thread.starter_message_id)).toBe(true);
    expect((await api.get(bob, `/threads/${thread.id}`)).status).toBe(404);
    expect(await db.get('SELECT COUNT(*) AS n FROM guild_messages WHERE channel_id = ?', [thread.id])).toEqual({ n: 0 });
    expect(await db.get('SELECT id FROM guild_messages WHERE id = ?', [thread.starter_message_id])).toBeUndefined();
    const entry = (await api.get(owner, `/guilds/${guild.id}/audit-log?actions=thread_delete`)).body.entries[0];
    expect(entry).toMatchObject({ action: 'thread_delete', channel_id: general.id, details: { name: 'Doomed', channelName: 'general' } });
  });

  it('deleting the channel deletes its threads', async () => {
    const { owner, guild } = await setUp();
    const channel = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'temp' })).body;
    const thread = (await api.post(owner, `/channels/${channel.id}/threads`, { name: 'inside' })).body;
    await say(owner, thread.id, 'hi');
    expect((await api.delete(owner, `/guilds/${guild.id}/channels/${channel.id}`)).status).toBe(200);
    expect(await db.get('SELECT id FROM guild_channels WHERE id = ?', [thread.id])).toBeUndefined();
    expect(await db.get('SELECT COUNT(*) AS n FROM guild_thread_members WHERE thread_id = ?', [thread.id])).toEqual({ n: 0 });
  });

  it('only text channels have threads', async () => {
    const { owner, guild } = await setUp();
    const voice = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'talk', type: 'voice' })).body;
    expect((await api.post(owner, `/channels/${voice.id}/threads`, { name: 'x' })).status).toBe(400);
    const thread = (await api.post(owner, `/channels/${guild.channels[0].id}/threads`, { name: 'x' })).body;
    expect((await api.post(owner, `/channels/${thread.id}/threads`, { name: 'nested' })).status).toBe(400);
  });

  it('pushes a mention in a thread with a link to it, and other messages only to its members', async () => {
    const { owner, members: [bob, carol], guild, general } = await setUp();
    for (const user of [bob, carol]) {
      await api.post(user, '/save-subscription', { subscription: { endpoint: `https://push.test/${user.username}`, keys: { p256dh: 'p', auth: 'a' } } });
      await api.put(user, `/guilds/${guild.id}/notifications`, { level: 'all' });
    }
    const thread = (await api.post(bob, `/channels/${general.id}/threads`, { name: 'Pushy' })).body;

    let since = sentPushes.length;
    await say(owner, thread.id, 'members only');
    await waitForPushes(1000, since, 300);
    const plain = sentPushes.slice(since).map((p) => p.endpoint);
    expect(plain).toContain(`https://push.test/${bob.username}`);
    expect(plain).not.toContain(`https://push.test/${carol.username}`);

    since = sentPushes.length;
    await say(owner, thread.id, `<@${carol.id}> you too`);
    await waitForPushes(1000, since, 300);
    const push = sentPushes.slice(since).find((p) => p.endpoint === `https://push.test/${carol.username}`);
    expect(push.payload).toMatchObject({ url: `/guild/${guild.id}/${general.id}?thread=${thread.id}` });
    expect(push.payload.title).toContain('Pushy, #general');
  });
});
