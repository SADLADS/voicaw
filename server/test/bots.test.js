import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import zlib from 'node:zlib';
import { registerUser, loginUser } from './helpers/authFlow.js';

const http = require('http');
const WebSocket = require('ws');
const app = require('../index.js');
const { attachWebSocketServer } = require('../sockets.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { toDiscordPermissions, fromDiscordPermissions, CATEGORY_ID_BASE } = require('../discord.js');

let userCount = 0;
async function makeUser(prefix = 'bot-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-bots-123';
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

// The bot API, as a Discord library calls it.
const botAuth = (bot) => ({ Authorization: `Bot ${bot.token}` });
const discord = {
  get: (bot, url) => request(app).get(`/api/v10${url}`).set(botAuth(bot)),
  post: (bot, url, body = {}) => request(app).post(`/api/v10${url}`).set(botAuth(bot)).send(body),
  put: (bot, url, body) => request(app).put(`/api/v10${url}`).set(botAuth(bot)).send(body),
  patch: (bot, url, body = {}) => request(app).patch(`/api/v10${url}`).set(botAuth(bot)).send(body),
  delete: (bot, url) => request(app).delete(`/api/v10${url}`).set(botAuth(bot)),
};

async function makeBot(owner, name = 'Helper Bot') {
  const res = await api.post(owner, '/applications', { name });
  expect(res.status).toBe(201);
  return { id: res.body.id, token: res.body.token, app: res.body };
}

// A guild (owner + a member) with #general, and a bot added by the owner with `permissions`
// (Discord's bits).
async function setUp(permissions = toDiscordPermissions(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ADD_REACTIONS)) {
  const owner = await makeUser('b-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Bots' })).body;
  const member = await makeUser('b-member');
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  await api.post(member, `/invites/${invite.body.code}`);
  const bot = await makeBot(owner);
  const added = await api.post(owner, '/oauth2/authorize', { client_id: String(bot.id), guild_id: guild.id, permissions });
  expect(added.status).toBe(201);
  const general = guild.channels[0];
  return { owner, member, guild, general, bot, everyone: guild.roles.find((r) => r.is_everyone) };
}

describe('permission bits', () => {
  it("map ours to Discord's and back", () => {
    expect(toDiscordPermissions(P.VIEW_CHANNEL)).toBe(String((1n << 10n) | (1n << 16n)));
    expect(fromDiscordPermissions(String(1n << 11n))).toBe(P.SEND_MESSAGES);
    expect(fromDiscordPermissions(toDiscordPermissions(P.KICK_MEMBERS | P.PIN_MESSAGES))).toBe(P.KICK_MEMBERS | P.PIN_MESSAGES);
    // Discord's bits we don't have are ignored; nonsense isn't accepted.
    expect(fromDiscordPermissions(String(1n << 14n))).toBe(0);
    expect(() => fromDiscordPermissions('abc')).toThrow();
  });
});

describe('the developer portal', () => {
  it('makes an application with a bot and a token shown once, and changes it', async () => {
    const owner = await makeUser();
    const bot = await makeBot(owner, 'Weather Bot');
    expect(bot.app).toMatchObject({ name: 'Weather Bot', public: true, bot: { username: 'weatherbot', discriminator: expect.stringMatching(/^\d{4}$/) } });
    expect(bot.token.split('.')).toHaveLength(3);
    expect(Buffer.from(bot.token.split('.')[0], 'base64url').toString()).toBe(String(bot.id));

    const list = await api.get(owner, '/applications');
    expect(list.body.map((a) => a.id)).toEqual([bot.id]);
    expect(list.body[0].token).toBeUndefined();
    expect((await api.get(await makeUser(), `/applications/${bot.id}`)).status).toBe(404);

    const changed = await api.patch(owner, `/applications/${bot.id}`, { name: 'Rain Bot', description: 'Says when it rains', public: false });
    expect(changed.body).toMatchObject({ name: 'Rain Bot', description: 'Says when it rains', public: false, bot: { username: 'rainbot', discriminator: bot.app.bot.discriminator } });
    expect((await api.patch(owner, `/applications/${bot.id}`, { name: 'x' })).status).toBe(400);

    // The token works until it's reset.
    expect((await discord.get(bot, '/users/@me')).body).toMatchObject({ id: String(bot.id), username: 'Rain Bot', bot: true });
    const reset = await api.post(owner, `/applications/${bot.id}/token`);
    expect((await discord.get(bot, '/users/@me')).status).toBe(401);
    expect((await discord.get({ token: reset.body.token }, '/users/@me')).status).toBe(200);

    expect((await api.delete(owner, `/applications/${bot.id}`)).status).toBe(200);
    expect((await discord.get({ token: reset.body.token }, '/users/@me')).status).toBe(401);
    expect((await api.get(owner, '/applications')).body).toEqual([]);
  });

  it("keeps bots out of logins, the DM list, DMs and calls, and '#' out of usernames", async () => {
    const owner = await makeUser();
    const bot = await makeBot(owner, 'Lonely Bot');
    const { body: { bot: { username, discriminator } } } = await api.get(owner, `/applications/${bot.id}`);

    const list = await api.get(owner, '/dms-list');
    expect(list.body.some((u) => u.id === bot.id)).toBe(false);
    const sent = await api.post(owner, '/dm-send', { recipient_id: bot.id, content: 'v1.hello' });
    expect(sent.status).toBe(404);
    const call = await api.post(owner, '/dm-calls', { calleeId: bot.id, callId: crypto.randomUUID(), keyEnvelope: 'v1.x' });
    expect([404, 503]).toContain(call.status);
    const typing = await api.post(owner, '/typing', { chatId: String(bot.id) });
    expect(typing.status).toBe(404);

    // Its username can't log in (it looks like nobody), nor be signed up with.
    const login = await loginUser(app, request, `${username}#${discriminator}`, 'pw-bots-123');
    expect(login.failedAt).toBe('finishLogin-client'); // the dummy answer for unknown names
    expect(login.response.body.token).toBeUndefined();
    const taken = await registerUser(app, request, `${username}#${discriminator}`, 'pw-bots-123');
    expect(taken.response.status).toBe(400);
  });
});

describe('adding a bot to a guild', () => {
  it('needs Manage Guild, gives the bot its own role with what was asked for, and takes it away when it leaves', async () => {
    const { owner, member, guild, bot } = await setUp(toDiscordPermissions(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.KICK_MEMBERS));
    const layout = (await api.get(owner, `/guilds/${guild.id}`)).body;
    const role = layout.roles.find((r) => r.bot_id === bot.id);
    expect(role).toMatchObject({ name: 'Helper Bot', permissions: P.VIEW_CHANNEL | P.SEND_MESSAGES | P.KICK_MEMBERS });
    const members = (await api.get(owner, `/guilds/${guild.id}/members`)).body;
    expect(members.find((m) => m.id === bot.id)).toMatchObject({ bot: 1, role_ids: [role.id] });

    // The role can't be deleted or given to anyone else.
    expect((await api.delete(owner, `/guilds/${guild.id}/roles/${role.id}`)).status).toBe(400);
    expect((await api.put(owner, `/guilds/${guild.id}/members/${member.id}/roles`, { roleIds: [role.id] })).status).toBe(400);

    // Members without Manage Guild can't add bots; the guild list only has guilds they could.
    const other = await makeBot(owner, 'Other Bot');
    expect((await api.get(member, `/oauth2/authorize?client_id=${other.id}`)).body.guilds).toEqual([]);
    expect((await api.post(member, '/oauth2/authorize', { client_id: other.id, guild_id: guild.id, permissions: '0' })).status).toBe(403);
    // A private application only by its owner.
    await api.patch(owner, `/applications/${other.id}`, { public: false });
    expect((await api.get(member, `/oauth2/authorize?client_id=${other.id}`)).status).toBe(404);

    // Kicked: gone with its role.
    expect((await api.delete(owner, `/guilds/${guild.id}/members/${bot.id}`)).status).toBe(200);
    const after = (await api.get(owner, `/guilds/${guild.id}`)).body;
    expect(after.roles.some((r) => r.bot_id === bot.id)).toBe(false);
    expect((await discord.get(bot, `/guilds/${guild.id}`)).body).toMatchObject({ code: 10004 });
  });

  it('only grants permissions the person adding it has', async () => {
    const { owner, guild, everyone } = await setUp();
    const manager = await makeUser();
    await api.post(manager, `/invites/${(await api.post(owner, `/guilds/${guild.id}/invites`)).body.code}`);
    await api.patch(owner, `/guilds/${guild.id}/roles/${everyone.id}`, { permissions: everyone.permissions | P.MANAGE_GUILD });
    const bot = await makeBot(owner, 'Greedy Bot');
    await api.post(manager, '/oauth2/authorize', { client_id: bot.id, guild_id: guild.id, permissions: toDiscordPermissions(P.ADMINISTRATOR | P.SEND_MESSAGES) });
    const role = (await api.get(owner, `/guilds/${guild.id}`)).body.roles.find((r) => r.bot_id === bot.id);
    expect(role.permissions).toBe(P.SEND_MESSAGES);
  });
});

describe('the bot API', () => {
  it('answers without a token, or a wrong one, with 401', async () => {
    expect((await request(app).get('/api/v10/users/@me')).status).toBe(401);
    expect((await request(app).get('/api/v10/users/@me').set({ Authorization: 'Bot nope.nope.nope' })).body).toMatchObject({ code: 0, message: '401: Unauthorized' });
    expect((await request(app).get('/api/v10/no-such-thing').set({ Authorization: 'Bot x' })).status).toBe(404);
  });

  it("shows the bot its guilds, channels, roles and members in Discord's shapes", async () => {
    const { owner, member, guild, general, bot, everyone } = await setUp();
    const gw = await discord.get(bot, '/gateway/bot');
    expect(gw.body).toMatchObject({ url: expect.stringMatching(/^wss?:\/\/.+\/api\/gateway$/), shards: 1 });

    expect((await discord.get(bot, '/users/@me/guilds')).body).toEqual([expect.objectContaining({ id: String(guild.id), name: 'Bots' })]);
    const g = (await discord.get(bot, `/guilds/${guild.id}?with_counts=true`)).body;
    expect(g).toMatchObject({ id: String(guild.id), owner_id: String(owner.id), approximate_member_count: 3 });
    // @everyone has the guild's id, as in Discord.
    expect(g.roles.find((r) => r.name === '@everyone')).toMatchObject({ id: String(guild.id), permissions: toDiscordPermissions(everyone.permissions) });
    expect(g.roles.find((r) => r.managed)).toMatchObject({ tags: { bot_id: String(bot.id) } });

    const channels = (await discord.get(bot, `/guilds/${guild.id}/channels`)).body;
    const category = channels.find((c) => c.type === 4);
    expect(Number(category.id)).toBeGreaterThan(CATEGORY_ID_BASE);
    expect(channels.find((c) => c.id === String(general.id))).toMatchObject({ type: 0, name: 'general', parent_id: category.id });
    expect((await discord.get(bot, `/channels/${category.id}`)).body).toMatchObject({ type: 4, name: category.name });

    const members = (await discord.get(bot, `/guilds/${guild.id}/members?limit=10`)).body;
    expect(members.map((m) => m.user.id).sort()).toEqual([owner.id, member.id, bot.id].map(String).sort());
    expect((await discord.get(bot, `/guilds/${guild.id}/members/search?query=b-mem`)).body.map((m) => m.user.id)).toEqual([String(member.id)]);
    expect((await discord.get(bot, `/users/${member.id}`)).body).toMatchObject({ username: member.username, bot: false });
    // Nobody it doesn't share a guild with.
    expect((await discord.get(bot, `/users/${(await makeUser()).id}`)).status).toBe(404);
    // DMs only with people it shares a guild with (botDms.test.js has the rest).
    expect((await discord.post(bot, '/users/@me/channels', { recipient_id: String((await makeUser()).id) })).body).toMatchObject({ code: 50007 });
    expect((await discord.post(bot, '/users/@me/channels', { recipient_id: String(member.id) })).body).toMatchObject({ type: 1 });
  });

  it('sends, reads, edits and deletes messages, with embeds, replies and reactions', async () => {
    const { owner, guild, general, bot } = await setUp(toDiscordPermissions(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ADD_REACTIONS));
    await api.post(owner, `/channels/${general.id}/messages`, { content: `hi <@${bot.id}>` });

    const sent = await discord.post(bot, `/channels/${general.id}/messages`, {
      content: 'Hello!',
      embeds: [{ title: 'Forecast', description: 'Sunny', color: 0xffcc00, fields: [{ name: 'High', value: '21°', inline: true }] }],
      nonce: 'abc',
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ content: 'Hello!', author: { id: String(bot.id), bot: true }, embeds: [{ title: 'Forecast' }], nonce: 'abc', type: 0 });

    const list = (await discord.get(bot, `/channels/${general.id}/messages?limit=10`)).body;
    expect(list.map((m) => m.content)).toEqual(['Hello!', `hi <@${bot.id}>`]); // newest first
    expect(list[1].mentions.map((u) => u.id)).toEqual([String(bot.id)]);
    expect((await discord.get(bot, `/channels/${general.id}/messages?after=${list[1].id}`)).body.map((m) => m.id)).toEqual([sent.body.id]);

    // The app shows it with its embed.
    const inApp = (await api.get(owner, `/channels/${general.id}/messages`)).body.at(-1);
    expect(inApp).toMatchObject({ sender_id: bot.id, sender_bot: 1, embeds: [{ title: 'Forecast' }] });

    const reply = await discord.post(bot, `/channels/${general.id}/messages`, { content: 'and a reply', message_reference: { message_id: list[1].id } });
    expect(reply.body).toMatchObject({ type: 19, message_reference: { message_id: list[1].id }, referenced_message: { content: `hi <@${bot.id}>` } });
    expect((await discord.post(bot, `/channels/${general.id}/messages`, {})).body).toMatchObject({ code: 50006 });

    const edited = await discord.patch(bot, `/channels/${general.id}/messages/${sent.body.id}`, { content: 'Hello again' });
    expect(edited.body).toMatchObject({ content: 'Hello again', embeds: [{ title: 'Forecast' }], edited_timestamp: expect.any(String) });
    // Only its own.
    expect((await discord.patch(bot, `/channels/${general.id}/messages/${list[1].id}`, { content: 'no' })).body).toMatchObject({ code: 50005 });
    expect((await discord.delete(bot, `/channels/${general.id}/messages/${list[1].id}`)).status).toBe(403);

    const thumbs = encodeURIComponent('👍');
    expect((await discord.put(bot, `/channels/${general.id}/messages/${list[1].id}/reactions/${thumbs}/@me`)).status).toBe(204);
    expect((await discord.get(bot, `/channels/${general.id}/messages/${list[1].id}`)).body.reactions).toEqual([
      expect.objectContaining({ count: 1, me: true, emoji: { id: null, name: '👍' } }),
    ]);
    expect((await discord.get(bot, `/channels/${general.id}/messages/${list[1].id}/reactions/${thumbs}`)).body.map((u) => u.id)).toEqual([String(bot.id)]);
    expect((await discord.delete(bot, `/channels/${general.id}/messages/${list[1].id}/reactions/${thumbs}/@me`)).status).toBe(204);

    expect((await discord.delete(bot, `/channels/${general.id}/messages/${sent.body.id}`)).status).toBe(204);
    expect((await discord.get(bot, `/channels/${general.id}/messages/${sent.body.id}`)).body).toMatchObject({ code: 10008 });
    expect(guild.id).toBeTruthy();
  });

  it('follows its permissions and channel overrides', async () => {
    const { owner, guild, general, bot } = await setUp(toDiscordPermissions(P.VIEW_CHANNEL | P.SEND_MESSAGES));
    // No Send Messages here for its role: refused.
    const role = (await api.get(owner, `/guilds/${guild.id}`)).body.roles.find((r) => r.bot_id === bot.id);
    await api.put(owner, `/guilds/${guild.id}/channels/${general.id}/overrides/role/${role.id}`, { allow: 0, deny: P.SEND_MESSAGES });
    expect((await discord.post(bot, `/channels/${general.id}/messages`, { content: 'hi' })).body).toMatchObject({ code: 50013 });
    expect((await discord.get(bot, `/channels/${general.id}`)).body.permission_overwrites).toEqual([
      { id: String(role.id), type: 0, allow: '0', deny: toDiscordPermissions(P.SEND_MESSAGES) },
    ]);
    // Hidden from it: as if it didn't exist.
    await api.put(owner, `/guilds/${guild.id}/channels/${general.id}/overrides/role/${role.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    expect((await discord.get(bot, `/channels/${general.id}/messages`)).body).toMatchObject({ code: 10003 });
    // Without Manage Roles / Kick Members / Manage Channels.
    expect((await discord.post(bot, `/guilds/${guild.id}/roles`, { name: 'x' })).body).toMatchObject({ code: 50013 });
    expect((await discord.delete(bot, `/guilds/${guild.id}/members/${owner.id}`)).status).toBe(403);
    expect((await discord.post(bot, `/guilds/${guild.id}/channels`, { name: 'new' })).status).toBe(403);
  });

  it('manages roles, members, bans and channels when allowed', async () => {
    const perms = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.MANAGE_ROLES | P.KICK_MEMBERS | P.BAN_MEMBERS | P.MANAGE_CHANNELS | P.MANAGE_MESSAGES | P.PIN_MESSAGES;
    const { owner, member, guild, general, bot } = await setUp(toDiscordPermissions(perms));
    // Its role must be above the roles it hands out: the owner moves it up.
    const role = (await discord.post(bot, `/guilds/${guild.id}/roles`, { name: 'Helper', permissions: toDiscordPermissions(P.SEND_MESSAGES), color: 0x00ff00 })).body;
    expect(role).toMatchObject({ name: 'Helper', color: 0x00ff00, permissions: toDiscordPermissions(P.SEND_MESSAGES), managed: false });
    const roles = (await api.get(owner, `/guilds/${guild.id}`)).body.roles.filter((r) => !r.is_everyone);
    const botRole = roles.find((r) => r.bot_id === bot.id);
    await api.put(owner, `/guilds/${guild.id}/roles/order`, { roleIds: [botRole.id, ...roles.filter((r) => r.id !== botRole.id).map((r) => r.id)] });

    expect((await discord.put(bot, `/guilds/${guild.id}/members/${member.id}/roles/${role.id}`)).status).toBe(204);
    expect((await discord.get(bot, `/guilds/${guild.id}/members/${member.id}`)).body.roles).toEqual([role.id]);
    // Can't take its own role away from itself.
    const me = (await discord.patch(bot, `/guilds/${guild.id}/members/${bot.id}`, { roles: [] })).body;
    expect(me.roles).toEqual([String(botRole.id)]);
    expect((await discord.patch(bot, `/guilds/${guild.id}/members/${member.id}`, { nick: 'Bob' })).body).toMatchObject({ code: 50035 });

    // A channel with an overwrite, renamed, then deleted.
    const made = await discord.post(bot, `/guilds/${guild.id}/channels`, {
      name: 'Bot Stuff', type: 0, permission_overwrites: [{ id: String(guild.id), type: 0, allow: '0', deny: toDiscordPermissions(P.SEND_MESSAGES) }],
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'bot-stuff', type: 0, permission_overwrites: [{ id: String(guild.id), type: 0 }] });
    expect((await discord.patch(bot, `/channels/${made.body.id}`, { name: 'bot things', topic: 'Beep' })).body).toMatchObject({ name: 'bot-things', topic: 'Beep' });
    expect((await discord.delete(bot, `/channels/${made.body.id}`)).status).toBe(200);

    // Pins and a thread.
    const msg = (await discord.post(bot, `/channels/${general.id}/messages`, { content: 'pin me' })).body;
    expect((await discord.put(bot, `/channels/${general.id}/pins/${msg.id}`)).status).toBe(204);
    expect((await discord.get(bot, `/channels/${general.id}/messages/pins`)).body.items.map((i) => i.message.id)).toEqual([msg.id]);
    const thread = await discord.post(bot, `/channels/${general.id}/messages/${msg.id}/threads`, { name: 'Chat about it' });
    expect(thread.body).toMatchObject({ type: 11, name: 'Chat about it', parent_id: String(general.id) });
    expect((await discord.post(bot, `/channels/${thread.body.id}/messages`, { content: 'in the thread' })).status).toBe(200);
    expect((await discord.get(bot, `/guilds/${guild.id}/threads/active`)).body.threads.map((t) => t.id)).toEqual([thread.body.id]);

    // Kick and ban (only people below it).
    expect((await discord.delete(bot, `/guilds/${guild.id}/members/${owner.id}`)).status).toBe(403);
    expect((await discord.put(bot, `/guilds/${guild.id}/bans/${member.id}`, {})).status).toBe(204);
    expect((await discord.get(bot, `/guilds/${guild.id}/bans`)).body.map((b) => b.user.id)).toEqual([String(member.id)]);
    expect((await discord.delete(bot, `/guilds/${guild.id}/bans/${member.id}`)).status).toBe(204);
    expect((await discord.delete(bot, `/guilds/${guild.id}/bans/${member.id}`)).body).toMatchObject({ code: 10026 });

    // The audit log says the bot did it.
    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body;
    const entries = log.entries ?? log;
    expect(entries.some((e) => e.action === 'member_ban_add' && e.actor_id === bot.id)).toBe(true);
  });

  it('describes its application', async () => {
    const { bot } = await setUp();
    expect((await discord.get(bot, '/oauth2/applications/@me')).body).toMatchObject({ id: String(bot.id), bot_public: true });
  });
});

// ---- The gateway ----

const server = http.createServer(app);
attachWebSocketServer(server);
const port = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
afterAll(() => new Promise((resolve) => server.close(resolve)));

// A gateway connection collecting what it's sent (inflated if `compress`).
async function connectGateway({ compress = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${await port}/api/gateway?v=10&encoding=json${compress ? '&compress=zlib-stream' : ''}`);
  const received = [];
  const waiters = [];
  const inflate = compress ? zlib.createInflate() : null;
  let pending = Buffer.alloc(0);
  const take = (payload) => {
    received.push(payload);
    for (const w of [...waiters]) if (w.test(payload)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(payload); }
  };
  ws.on('message', (data, binary) => {
    if (!compress) return take(JSON.parse(data.toString()));
    expect(binary).toBe(true);
    inflate.write(data);
    inflate.flush(() => {
      let chunk;
      while ((chunk = inflate.read())) pending = Buffer.concat([pending, chunk]);
      if (pending.length) { take(JSON.parse(pending.toString())); pending = Buffer.alloc(0); }
    });
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const next = (test) => {
    const found = received.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      waiters.push({ test, resolve });
      setTimeout(() => reject(new Error('Timed out waiting for a gateway payload')), 5000);
    });
  };
  await new Promise((resolve) => ws.on('open', resolve));
  return { ws, received, next, closed, send: (payload) => ws.send(JSON.stringify(payload)) };
}

const dispatch = (t) => (p) => p.op === 0 && p.t === t;

describe('the gateway', () => {
  it('says hello, identifies, sends READY and GUILD_CREATE, then the guild\'s events', async () => {
    const { owner, member, guild, general, bot } = await setUp();
    const gw = await connectGateway();
    const hello = await gw.next((p) => p.op === 10);
    expect(hello.d.heartbeat_interval).toBeGreaterThan(0);
    gw.send({ op: 1, d: null });
    await gw.next((p) => p.op === 11);

    // GUILDS | GUILD_MEMBERS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | MESSAGE_CONTENT
    gw.send({ op: 2, d: { token: bot.token, intents: 1 | 2 | 512 | 1024 | 32768, properties: { os: 'linux', browser: 'test', device: 'test' } } });
    const ready = await gw.next(dispatch('READY'));
    expect(ready.d).toMatchObject({ v: 10, user: { id: String(bot.id), bot: true }, guilds: [{ id: String(guild.id), unavailable: true }] });
    const created = await gw.next(dispatch('GUILD_CREATE'));
    expect(created.d).toMatchObject({ id: String(guild.id), member_count: 3, unavailable: false });
    expect(created.d.channels.some((c) => c.id === String(general.id))).toBe(true);

    // The bot shows as online.
    const members = (await api.get(owner, `/guilds/${guild.id}/members`)).body;
    expect(members.find((m) => m.id === bot.id).status).toBe('online');

    await api.post(member, `/channels/${general.id}/messages`, { content: 'hello bot' });
    const message = await gw.next(dispatch('MESSAGE_CREATE'));
    expect(message.d).toMatchObject({ content: 'hello bot', guild_id: String(guild.id), channel_id: String(general.id), author: { id: String(member.id) }, member: { roles: [] } });
    expect(message.s).toBeGreaterThan(ready.s);

    await api.post(member, `/guild-messages/${message.d.id}/reactions`, { emoji: '🎉' });
    expect((await gw.next(dispatch('MESSAGE_REACTION_ADD'))).d).toMatchObject({ user_id: String(member.id), message_id: message.d.id, emoji: { id: null, name: '🎉' } });

    // A new channel and a role change arrive as differences.
    await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'news' });
    expect((await gw.next(dispatch('CHANNEL_CREATE'))).d).toMatchObject({ name: 'news', type: 0, guild_id: String(guild.id) });
    await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Mods' });
    expect((await gw.next(dispatch('GUILD_ROLE_CREATE'))).d).toMatchObject({ guild_id: String(guild.id), role: { name: 'Mods' } });

    // Members asked for.
    gw.send({ op: 8, d: { guild_id: String(guild.id), query: '', limit: 0, nonce: 'n1' } });
    const chunk = await gw.next(dispatch('GUILD_MEMBERS_CHUNK'));
    expect(chunk.d).toMatchObject({ guild_id: String(guild.id), nonce: 'n1', chunk_index: 0, chunk_count: 1 });
    expect(chunk.d.members).toHaveLength(3);

    // Kicked: GUILD_DELETE.
    await api.delete(owner, `/guilds/${guild.id}/members/${bot.id}`);
    expect((await gw.next(dispatch('GUILD_DELETE'))).d).toEqual({ id: String(guild.id) });
    gw.ws.close(1000);
    await gw.closed;
  });

  it('only sends the events of the intents asked for, and refuses bad tokens and intents', async () => {
    const { member, general, bot } = await setUp();
    const quiet = await connectGateway();
    quiet.send({ op: 2, d: { token: bot.token, intents: 1 } }); // GUILDS only
    await quiet.next(dispatch('GUILD_CREATE'));
    await api.post(member, `/channels/${general.id}/messages`, { content: 'not for you' });
    await new Promise((r) => setTimeout(r, 300));
    expect(quiet.received.some(dispatch('MESSAGE_CREATE'))).toBe(false);
    quiet.ws.close(1000);

    const wrong = await connectGateway();
    wrong.send({ op: 2, d: { token: 'Bot nope', intents: 0 } });
    expect(await wrong.closed).toBe(4004);
    const bad = await connectGateway();
    bad.send({ op: 2, d: { token: bot.token, intents: 1 << 30 } });
    expect(await bad.closed).toBe(4013);
    const unknown = await connectGateway();
    unknown.send({ op: 99 });
    expect(await unknown.closed).toBe(4001);
  });

  it('works with zlib-stream compression, and resumes a dropped session', async () => {
    const { member, general, bot } = await setUp();
    const first = await connectGateway({ compress: true });
    first.send({ op: 2, d: { token: bot.token, intents: 1 | 512 } });
    const ready = await first.next(dispatch('READY'));
    await first.next(dispatch('GUILD_CREATE'));
    const lastSeq = Math.max(...first.received.map((p) => p.s ?? 0));
    first.ws.close(4000); // dropped, not ended
    await first.closed;

    await api.post(member, `/channels/${general.id}/messages`, { content: 'while you were away' });
    const second = await connectGateway();
    second.send({ op: 6, d: { token: bot.token, session_id: ready.d.session_id, seq: lastSeq } });
    expect((await second.next(dispatch('MESSAGE_CREATE'))).d.content).toBe('while you were away');
    await second.next(dispatch('RESUMED'));

    // An unknown session can't be resumed.
    const third = await connectGateway();
    third.send({ op: 6, d: { token: bot.token, session_id: 'nope', seq: 1 } });
    expect((await third.next((p) => p.op === 9)).d).toBe(false);
    second.ws.close(1000);
    third.ws.close(1000);
  });

  it("ends the bot's sessions when its token is reset", async () => {
    const { owner, bot } = await setUp();
    const gw = await connectGateway();
    gw.send({ op: 2, d: { token: bot.token, intents: 1 } });
    await gw.next(dispatch('READY'));
    await api.post(owner, `/applications/${bot.id}/token`);
    expect(await gw.closed).toBe(4004);
  });
});
