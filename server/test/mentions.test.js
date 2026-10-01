import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { PERMISSIONS: P, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');
const { parseMentions } = require('../mentions.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'mention-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-mentions-123';
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

// A connected socket for `user` (collecting events), optionally looking at a chat.
function connect(user, presence = {}) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now(), ...presence } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  Object.defineProperty(events, 'stop', {
    value: () => clients.set(String(user.id), clients.get(String(user.id)).filter((s) => s !== ws)),
  });
  return events;
}

async function subscribe(user) {
  const endpoint = `https://push.test/${user.username}`;
  await api.post(user, '/save-subscription', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
  return endpoint;
}

// A guild with an owner and `count` members (all subscribed to pushes), and its #general.
async function setUp(count = 2) {
  const owner = await makeUser('m-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Pings' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('m-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    user.endpoint = await subscribe(user);
    members.push(user);
  }
  owner.endpoint = await subscribe(owner);
  return { owner, members, guild, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

const say = (user, channel, content) => api.post(user, `/channels/${channel.id}/messages`, { content });
const unreadFor = async (user, channel) => (await api.get(user, '/guild-unread')).body.find((u) => u.channel_id === channel.id);

// The pushes sent since `since` (after giving them time to go out), by endpoint.
async function pushesSince(since) {
  await waitForPushes(1000, since, 300);
  return sentPushes.slice(since);
}

describe('parseMentions', () => {
  it('finds users, roles, @everyone and @here, but not inside code', () => {
    const found = parseMentions('hi <@1> <@&2> @everyone `<@3>` ```\n@here <@4>\n```');
    expect([...found.userIds]).toEqual([1]);
    expect([...found.roleIds]).toEqual([2]);
    expect(found.everyone).toBe(true);
    expect(found.here).toBe(false);
    expect(parseMentions('mail me@everyone.test').everyone).toBe(false);
    expect(parseMentions('(@here)').here).toBe(true);
  });
});

describe('guild mentions', () => {
  it('pushes to the person mentioned (by default only them), with a readable preview', async () => {
    const { owner, members: [bob, carol], general, guild } = await setUp(2);
    const bobEvents = connect(bob);
    const since = sentPushes.length;
    const res = await say(owner, general, `hey <@${bob.id}> see ![cat\\_1.png](https://media.test/a.bin#k=SECRET) ![ending.png](https://media.test/b.bin#v=1&k=SECRET&sp=1) <:blob:9> ||ending||`);
    expect(res.status).toBe(201);

    const pushes = await pushesSince(since);
    expect(pushes.map((p) => p.endpoint)).toEqual([bob.endpoint]);
    expect(pushes[0].payload).toMatchObject({
      type: 'guild',
      title: `${owner.username} (#general, Pings)`,
      body: `hey @${bob.username} see 📎 cat_1.png 📎 spoiler :blob: [spoiler]`,
      url: `/guild/${guild.id}/${general.id}`,
      tag: `channel-${general.id}`,
    });
    expect(JSON.stringify(pushes[0].payload)).not.toContain('SECRET');
    expect(bobEvents.find((e) => e.type === 'guild_mention')).toMatchObject({ channelId: general.id, messageId: res.body.id });
    expect(await unreadFor(bob, general)).toMatchObject({ count: 1, mentions: 1 });
    expect(await unreadFor(carol, general)).toMatchObject({ count: 1, mentions: 0 });
    bobEvents.stop();
  });

  it("doesn't push to someone looking at the channel, or mentioning themselves", async () => {
    const { owner, members: [bob], general } = await setUp(1);
    const watching = connect(bob, { visible: true, chatId: `channel-${general.id}` });
    const since = sentPushes.length;
    await say(owner, general, `<@${bob.id}> <@${owner.id}>`);
    expect(await pushesSince(since)).toEqual([]);
    watching.stop();
  });

  it('follows each member\'s notification level', async () => {
    const { owner, members: [bob, carol], general, guild } = await setUp(2);
    expect((await api.get(bob, `/guilds/${guild.id}`)).body.my_notify_level).toBe('mentions');
    expect((await api.put(bob, `/guilds/${guild.id}/notifications`, { level: 'all' })).status).toBe(200);
    expect((await api.put(carol, `/guilds/${guild.id}/notifications`, { level: 'none' })).status).toBe(200);
    expect((await api.put(carol, `/guilds/${guild.id}/notifications`, { level: 'loud' })).status).toBe(400);
    expect((await api.get(bob, `/guilds/${guild.id}`)).body.my_notify_level).toBe('all');

    let since = sentPushes.length;
    await say(owner, general, 'plain message');
    expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([bob.endpoint]);

    since = sentPushes.length;
    await say(owner, general, `<@${carol.id}>`);
    expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([bob.endpoint]);
    // Carol still sees the mention count, just no push.
    expect(await unreadFor(carol, general)).toMatchObject({ mentions: 1 });
  });

  it('@everyone and @here need Mention Everyone; @here only reaches people online', async () => {
    const { owner, members: [bob, carol], general, guild, everyone } = await setUp(2);
    let since = sentPushes.length;
    const plain = await say(bob, general, '@everyone look');
    expect(plain.body.mention_everyone).toBe(0);
    expect((await pushesSince(since)).length).toBe(0);

    await api.patch(owner, `/guilds/${guild.id}/roles/${everyone.id}`, { permissions: DEFAULT_EVERYONE_PERMISSIONS | P.MENTION_EVERYONE });
    since = sentPushes.length;
    const loud = await say(bob, general, '@everyone look');
    expect(loud.body.mention_everyone).toBe(1);
    expect((await pushesSince(since)).map((p) => p.endpoint).sort()).toEqual([owner.endpoint, carol.endpoint].sort());

    const online = connect(carol);
    require('../sockets.js').refreshStatus(String(carol.id));
    since = sentPushes.length;
    await say(bob, general, '@here quick one');
    expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([carol.endpoint]);
    online.stop();
  });

  it('role mentions ping the role\'s members when it is mentionable or the sender may mention all roles', async () => {
    const { owner, members: [bob, carol], general, guild } = await setUp(2);
    const role = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Raiders' })).body;
    expect(role.mentionable).toBe(0);
    await api.put(owner, `/guilds/${guild.id}/members/${carol.id}/roles`, { roleIds: [role.id] });

    let since = sentPushes.length;
    const quiet = await say(bob, general, `<@&${role.id}> go`);
    expect(quiet.body.mention_roles).toEqual([]);
    expect((await pushesSince(since)).length).toBe(0);

    // The owner has every permission, so their role mentions always count.
    since = sentPushes.length;
    const byOwner = await say(owner, general, `<@&${role.id}> go`);
    expect(byOwner.body.mention_roles).toEqual([role.id]);
    expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([carol.endpoint]);

    expect((await api.patch(owner, `/guilds/${guild.id}/roles/${role.id}`, { mentionable: true })).body.mentionable).toBe(1);
    since = sentPushes.length;
    await say(bob, general, `<@&${role.id}> go`);
    const pushes = await pushesSince(since);
    expect(pushes.map((p) => p.endpoint)).toEqual([carol.endpoint]);
    expect(pushes[0].payload.body).toBe('@Raiders go');
  });

  it('only mentions people who can see the channel, and lists them', async () => {
    const { owner, members: [bob, carol], guild, everyone } = await setUp(2);
    const secret = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'secret', type: 'text' })).body;
    await api.put(owner, `/guilds/${guild.id}/channels/${secret.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    await api.put(owner, `/guilds/${guild.id}/channels/${secret.id}/overrides/member/${bob.id}`, { allow: P.VIEW_CHANNEL, deny: 0 });

    expect((await api.get(bob, `/channels/${secret.id}/members`)).body.sort()).toEqual([owner.id, bob.id].sort());
    expect((await api.get(carol, `/channels/${secret.id}/members`)).status).toBe(404);

    const since = sentPushes.length;
    await say(owner, secret, `<@${bob.id}> <@${carol.id}>`);
    expect((await pushesSince(since)).map((p) => p.endpoint)).toEqual([bob.endpoint]);
  });

  it('names channel mentions in pushes only for those who can see the channel', async () => {
    const { owner, members: [bob, carol], guild, general, everyone } = await setUp(2);
    const secret = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'secret', type: 'text' })).body;
    await api.put(owner, `/guilds/${guild.id}/channels/${secret.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    await api.put(owner, `/guilds/${guild.id}/channels/${secret.id}/overrides/member/${bob.id}`, { allow: P.VIEW_CHANNEL, deny: 0 });
    await api.put(bob, `/guilds/${guild.id}/notifications`, { level: 'all' });
    await api.put(carol, `/guilds/${guild.id}/notifications`, { level: 'all' });

    const since = sentPushes.length;
    await say(owner, general, `see <#${general.id}> and <#${secret.id}> and <#999999>`);
    const bodies = Object.fromEntries((await pushesSince(since)).map((p) => [p.endpoint, p.payload.body]));
    expect(bodies[bob.endpoint]).toBe('see #general and #secret and #unknown-channel');
    expect(bodies[carol.endpoint]).toBe('see #general and #unknown-channel and #unknown-channel');
  });

  it('works mentions out again on edit (without pushing), and forgets them on delete', async () => {
    const { owner, members: [bob], general } = await setUp(1);
    const events = connect(bob);
    const sent = (await say(owner, general, 'nothing yet')).body;
    const since = sentPushes.length;
    await api.put(owner, `/guild-messages/${sent.id}`, { content: `now <@${bob.id}>` });
    expect(await pushesSince(since)).toEqual([]);
    expect(await unreadFor(bob, general)).toMatchObject({ mentions: 1 });
    expect(events.find((e) => e.type === 'guild_message_edit')).toMatchObject({ mention_everyone: 0, mention_roles: [] });

    await api.delete(owner, `/guild-messages/${sent.id}`);
    expect(await unreadFor(bob, general)).toBeUndefined();
    events.stop();
  });
});
