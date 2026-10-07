import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const http = require('http');
const WebSocket = require('ws');
const app = require('../index.js');
const db = require('../db.js');
const { attachWebSocketServer } = require('../sockets.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { toDiscordPermissions } = require('../discord.js');
const botDms = require('../botDms.js');

// Bot DMs (botDms.js): unencrypted conversations between a bot and one person.

let userCount = 0;
async function makeUser(prefix = 'bdm-user') {
  const username = `${prefix}-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-bot-dms-1');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-bot-dms-1');
  return { id: regRes.body.id, username, token: loginRes.body.token };
}
const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};
const botAuth = (bot) => ({ Authorization: `Bot ${bot.token}` });
const discord = {
  get: (bot, url) => request(app).get(`/api/v10${url}`).set(botAuth(bot)),
  post: (bot, url, body = {}) => request(app).post(`/api/v10${url}`).set(botAuth(bot)).send(body),
  put: (bot, url, body = {}) => request(app).put(`/api/v10${url}`).set(botAuth(bot)).send(body),
  patch: (bot, url, body = {}) => request(app).patch(`/api/v10${url}`).set(botAuth(bot)).send(body),
  delete: (bot, url) => request(app).delete(`/api/v10${url}`).set(botAuth(bot)),
};

// A guild with its owner, a member and a bot.
async function setUp() {
  const owner = await makeUser('bdm-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'DM Bots' })).body;
  const member = await makeUser('bdm-member');
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  await api.post(member, `/invites/${invite.body.code}`);
  const created = await api.post(owner, '/applications', { name: 'Reminder' });
  const bot = { id: created.body.id, token: created.body.token };
  await api.post(owner, '/oauth2/authorize', { client_id: String(bot.id), guild_id: guild.id, permissions: toDiscordPermissions(P.VIEW_CHANNEL | P.SEND_MESSAGES) });
  return { owner, member, guild, bot };
}

const openDm = async (bot, user) => discord.post(bot, '/users/@me/channels', { recipient_id: String(user.id) });

describe('bot DMs', () => {
  it('lets a bot message someone it shares a guild with, who reads and answers in the app', async () => {
    const { member, bot } = await setUp();
    const opened = await openDm(bot, member);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ type: 1, recipients: [{ id: String(member.id), username: member.username }] });
    expect(Number(opened.body.id)).toBeGreaterThan(botDms.CHANNEL_BASE);
    // Opening again finds the same one.
    expect((await openDm(bot, member)).body.id).toBe(opened.body.id);

    const sent = await discord.post(bot, `/channels/${opened.body.id}/messages`, {
      content: "It's your move in game 12", embeds: [{ title: 'Chess', description: 'Day 2 reminder' }],
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ channel_id: opened.body.id, content: "It's your move in game 12", author: { id: String(bot.id), bot: true } });
    expect(sent.body.guild_id).toBeUndefined();
    expect(sent.body.embeds[0]).toMatchObject({ title: 'Chess' });

    // The person's list: one conversation, one unread.
    const list = (await api.get(member, '/bot-dms')).body;
    expect(list).toEqual([expect.objectContaining({ bot_id: bot.id, unread: 1, last_unread_sender_id: bot.id })]);
    const dmId = list[0].id;
    const messages = (await api.get(member, `/bot-dms/${dmId}/messages`)).body;
    expect(messages).toEqual([expect.objectContaining({ sender_id: bot.id, plaintext: "It's your move in game 12" })]);
    expect(messages[0].embeds[0]).toMatchObject({ title: 'Chess' });
    // Stored as plain text: these aren't end-to-end encrypted.
    expect((await db.get('SELECT content FROM bot_dm_messages WHERE dm_id = ?', [dmId])).content).toBe("It's your move in game 12");

    // Reading says what was unread from (where the chat's "New" divider goes).
    expect((await api.post(member, `/bot-dms/${dmId}/read`, { messageId: messages[0].id })).body.first_unread_id).toBe(messages[0].id);
    expect((await api.get(member, '/bot-dms')).body[0].unread).toBe(0);
    expect((await api.post(member, `/bot-dms/${dmId}/read`, { messageId: messages[0].id })).body.first_unread_id).toBeNull();

    const reply = await api.post(member, `/bot-dms/${dmId}/messages`, { content: 'On it' });
    expect(reply.status).toBe(201);
    const history = (await discord.get(bot, `/channels/${opened.body.id}/messages`)).body;
    expect(history.map((m) => m.content)).toEqual(['On it', "It's your move in game 12"]);
    expect(history[0].author).toMatchObject({ id: String(member.id), bot: false });
    expect((await discord.get(bot, `/channels/${opened.body.id}/messages?after=${sent.body.id}`)).body.map((m) => m.content)).toEqual(['On it']);
    expect((await discord.get(bot, `/channels/${opened.body.id}`)).body).toMatchObject({ type: 1, last_message_id: history[0].id });
  });

  it('edits and deletes only its own messages; no components, reactions or pins', async () => {
    const { member, bot } = await setUp();
    const channel = (await openDm(bot, member)).body;
    const sent = (await discord.post(bot, `/channels/${channel.id}/messages`, { content: 'v1' })).body;
    const edited = await discord.patch(bot, `/channels/${channel.id}/messages/${sent.id}`, { content: 'v2' });
    expect(edited.body).toMatchObject({ content: 'v2' });
    expect(edited.body.edited_timestamp).toBeTruthy();

    const dmId = (await api.get(member, '/bot-dms')).body[0].id;
    const theirs = (await api.post(member, `/bot-dms/${dmId}/messages`, { content: 'mine' })).body;
    const theirsApi = botDms.apiMessageId(theirs.id);
    expect((await discord.patch(bot, `/channels/${channel.id}/messages/${theirsApi}`, { content: 'x' })).body.code).toBe(50005);
    expect((await discord.delete(bot, `/channels/${channel.id}/messages/${theirsApi}`)).status).toBe(403);
    // The person can't change the bot's.
    const botsOwn = (await api.get(member, `/bot-dms/${dmId}/messages`)).body[0];
    expect((await api.delete(member, `/bot-dms/${dmId}/messages/${botsOwn.id}`)).status).toBe(403);
    expect((await api.put(member, `/bot-dms/${dmId}/messages/${theirs.id}`, { content: 'mine, edited' })).body.plaintext).toBe('mine, edited');

    expect((await discord.delete(bot, `/channels/${channel.id}/messages/${sent.id}`)).status).toBe(204);
    expect((await api.get(member, `/bot-dms/${dmId}/messages`)).body.map((m) => m.plaintext)).toEqual(['mine, edited']);

    const buttons = await discord.post(bot, `/channels/${channel.id}/messages`, {
      content: 'pick', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'A', custom_id: 'a' }] }],
    });
    expect(buttons.status).toBe(400);
    expect((await discord.put(bot, `/channels/${channel.id}/messages/${sent.id}/reactions/%F0%9F%91%8D/@me`)).body.code).toBe(50003);
    expect((await discord.put(bot, `/channels/${channel.id}/pins/${sent.id}`)).body.code).toBe(50003);
  });

  it("refuses strangers, blocks, people who turned bot DMs off, and other bots' DMs", async () => {
    const { owner, member, bot } = await setUp();
    expect((await openDm(bot, await makeUser())).body.code).toBe(50007);
    // Another bot, not in the guild, can't see this one's DM.
    const channel = (await openDm(bot, member)).body;
    const other = (await api.post(owner, '/applications', { name: 'Other' })).body;
    expect((await discord.get({ token: other.token }, `/channels/${channel.id}`)).status).toBe(404);

    await api.put(member, '/preferences', { botDms: false });
    expect((await openDm(bot, member)).body.code).toBe(50007);
    expect((await discord.post(bot, `/channels/${channel.id}/messages`, { content: 'hi' })).body.code).toBe(50007);
    await api.put(member, '/preferences', { botDms: true });
    expect((await discord.post(bot, `/channels/${channel.id}/messages`, { content: 'hi' })).status).toBe(200);

    await api.put(member, `/blocks/${bot.id}`);
    expect((await discord.post(bot, `/channels/${channel.id}/messages`, { content: 'hi' })).body.code).toBe(50007);
    const dmId = (await api.get(member, '/bot-dms')).body[0].id;
    expect((await api.post(member, `/bot-dms/${dmId}/messages`, { content: 'hey' })).status).toBe(403);
    // Someone else can't read it.
    expect((await api.get(owner, `/bot-dms/${dmId}/messages`)).status).toBe(404);
  });

  it('can be started by the person, and deleted by them for both sides', async () => {
    const { member, bot } = await setUp();
    expect((await api.post(await makeUser(), '/bot-dms', { bot_id: bot.id })).status).toBe(403);
    const started = await api.post(member, '/bot-dms', { bot_id: bot.id });
    expect(started.status).toBe(201);
    await api.post(member, `/bot-dms/${started.body.id}/messages`, { content: '/help' });
    expect((await openDm(bot, member)).body.id).toBe(botDms.apiChannelId(started.body.id));

    expect((await api.delete(member, `/bot-dms/${started.body.id}`)).status).toBe(200);
    expect((await api.get(member, '/bot-dms')).body).toEqual([]);
    expect(await db.get('SELECT 1 FROM bot_dm_messages WHERE dm_id = ?', [started.body.id])).toBeUndefined();
    expect((await discord.get(bot, `/channels/${botDms.apiChannelId(started.body.id)}`)).status).toBe(404);
  });

  it("goes with the application and with the person's account", async () => {
    const { owner, member, bot } = await setUp();
    const channel = (await openDm(bot, member)).body;
    await discord.post(bot, `/channels/${channel.id}/messages`, { content: 'hello' });
    await request(app).delete(`/api/applications/${bot.id}`).set(authed(owner));
    expect((await api.get(member, '/bot-dms')).body).toEqual([]);
    expect(await db.get('SELECT 1 FROM bot_dms WHERE bot_id = ?', [bot.id])).toBeUndefined();

    const second = await setUp();
    await discord.post(second.bot, `/channels/${(await openDm(second.bot, second.member)).body.id}/messages`, { content: 'hello' });
    const userId = second.member.id;
    await require('../accounts.js').deleteAccount(userId, { guilds: [], leaves: [] });
    expect(await db.get('SELECT 1 FROM bot_dms WHERE user_id = ?', [userId])).toBeUndefined();
  });

  it('can be muted and pinned like other conversations', async () => {
    const { member, bot } = await setUp();
    await openDm(bot, member);
    const dmId = (await api.get(member, '/bot-dms')).body[0].id;
    const res = await api.put(member, `/conversation-settings/bot/${dmId}`, { pinned: true, mute: { duration: null } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'bot', target: String(dmId), muted: true });
    expect((await api.put(await makeUser(), `/conversation-settings/bot/${dmId}`, { pinned: true })).status).toBe(404);
  });
});

// ---- The gateway ----

const server = http.createServer(app);
attachWebSocketServer(server);
const port = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
afterAll(() => new Promise((resolve) => server.close(resolve)));

async function connectGateway(bot, intents) {
  const ws = new WebSocket(`ws://127.0.0.1:${await port}/api/gateway?v=10&encoding=json`);
  const received = [];
  ws.on('message', (data) => received.push(JSON.parse(data.toString())));
  await new Promise((resolve) => ws.on('open', resolve));
  const next = async (test) => {
    for (let i = 0; i < 100; i++) {
      const found = received.find(test);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out waiting for a gateway payload');
  };
  await next((p) => p.op === 10);
  ws.send(JSON.stringify({ op: 2, d: { token: bot.token, intents, properties: { os: 'linux', browser: 'test', device: 'test' } } }));
  await next((p) => p.t === 'READY');
  return { ws, received, next };
}
const dispatch = (t) => (p) => p.op === 0 && p.t === t;

describe('bot DMs on the gateway', () => {
  it('sends MESSAGE_CREATE, _UPDATE and _DELETE with the Direct Messages intent only', async () => {
    const { member, bot } = await setUp();
    const withDms = await connectGateway(bot, 1 | (1 << 12));
    const without = await connectGateway(bot, 1 | (1 << 9));
    const channel = (await openDm(bot, member)).body;
    const dmId = (await api.post(member, '/bot-dms', { bot_id: bot.id })).body.id;

    const mine = (await api.post(member, `/bot-dms/${dmId}/messages`, { content: 'ping' })).body;
    const created = await withDms.next(dispatch('MESSAGE_CREATE'));
    expect(created.d).toMatchObject({ channel_id: channel.id, content: 'ping', author: { id: String(member.id) } });
    expect(created.d.guild_id).toBeUndefined();

    await api.put(member, `/bot-dms/${dmId}/messages/${mine.id}`, { content: 'ping!' });
    expect((await withDms.next(dispatch('MESSAGE_UPDATE'))).d).toMatchObject({ content: 'ping!' });
    await api.delete(member, `/bot-dms/${dmId}/messages/${mine.id}`);
    expect((await withDms.next(dispatch('MESSAGE_DELETE'))).d).toEqual({ id: botDms.apiMessageId(mine.id), channel_id: channel.id });

    expect(without.received.some(dispatch('MESSAGE_CREATE'))).toBe(false);
    withDms.ws.close();
    without.ws.close();
  });
});
