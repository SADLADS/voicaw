import './helpers/mockS3.js';
import { objects } from './helpers/mockS3.js';
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const http = require('http');
const WebSocket = require('ws');
const sharp = require('sharp');
const app = require('../index.js');
const { attachWebSocketServer } = require('../sockets.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { toDiscordPermissions } = require('../discord.js');

let userCount = 0;
async function makeUser(prefix = 'be-user') {
  const username = `${prefix}-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-bot-events-1');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-bot-events-1');
  return { id: regRes.body.id, username, token: loginRes.body.token };
}
const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};
const botAuth = (bot) => ({ Authorization: `Bot ${bot.token}` });
const discord = {
  get: (bot, url) => request(app).get(`/api/v10${url}`).set(botAuth(bot)),
  post: (bot, url, body = {}) => request(app).post(`/api/v10${url}`).set(botAuth(bot)).send(body),
  patch: (bot, url, body = {}) => request(app).patch(`/api/v10${url}`).set(botAuth(bot)).send(body),
  delete: (bot, url) => request(app).delete(`/api/v10${url}`).set(botAuth(bot)),
};

async function setUp(permissions = P.VIEW_CHANNEL | P.CONNECT | P.CREATE_EVENTS | P.MANAGE_EVENTS) {
  const owner = await makeUser('be-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Event Bots' })).body;
  const lounge = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' })).body;
  const created = await api.post(owner, '/applications', { name: 'Planner' });
  const bot = { id: created.body.id, token: created.body.token };
  await api.post(owner, '/oauth2/authorize', { client_id: String(bot.id), guild_id: guild.id, permissions: toDiscordPermissions(permissions) });
  return { owner, guild, lounge, bot };
}

const iso = (s) => new Date(s * 1000).toISOString();
const soon = () => Math.floor(Date.now() / 1000) + 3600;

describe('scheduled events in the bot API', () => {
  it("maps Create Events and Manage Events to Discord's bits", () => {
    expect(BigInt(toDiscordPermissions(P.CREATE_EVENTS))).toBe(1n << 44n);
    expect(BigInt(toDiscordPermissions(P.MANAGE_EVENTS))).toBe(1n << 33n);
  });

  it('creates, lists, modifies, starts, ends and cancels events', async () => {
    const { owner, guild, lounge, bot } = await setUp();
    const start = soon();
    const res = await discord.post(bot, `/guilds/${guild.id}/scheduled-events`, {
      name: 'Raid', description: 'Bring potions', privacy_level: 2, entity_type: 2, channel_id: String(lounge.id),
      scheduled_start_time: iso(start),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      guild_id: String(guild.id), channel_id: String(lounge.id), creator_id: String(bot.id), name: 'Raid', description: 'Bring potions',
      scheduled_start_time: iso(start), scheduled_end_time: null, privacy_level: 2, status: 1, entity_type: 2,
      entity_metadata: null, creator: { id: String(bot.id), bot: true }, user_count: 1, image: null, recurrence_rule: null,
    });
    const id = res.body.id;

    // People see it in the app.
    expect((await api.get(owner, `/guilds/${guild.id}/events`)).body).toEqual([expect.objectContaining({ id: Number(id), name: 'Raid' })]);
    await api.put(owner, `/guild-events/${id}/interest`);

    const list = (await discord.get(bot, `/guilds/${guild.id}/scheduled-events?with_user_count=true`)).body;
    expect(list).toEqual([expect.objectContaining({ id, user_count: 2 })]);
    expect((await discord.get(bot, `/guilds/${guild.id}/scheduled-events`)).body[0].user_count).toBeUndefined();

    const users = (await discord.get(bot, `/guilds/${guild.id}/scheduled-events/${id}/users?with_member=true`)).body;
    expect(users.map((u) => u.user.id).sort()).toEqual([String(bot.id), String(owner.id)].sort());
    expect(users[0]).toMatchObject({ guild_scheduled_event_id: id, member: { roles: expect.any(Array) } });

    // Moved somewhere else (needs an end and a location).
    const patched = await discord.patch(bot, `/guilds/${guild.id}/scheduled-events/${id}`, {
      entity_type: 3, entity_metadata: { location: 'Town square' }, scheduled_end_time: iso(start + 7200),
    });
    expect(patched.body).toMatchObject({ entity_type: 3, channel_id: null, entity_metadata: { location: 'Town square' }, scheduled_end_time: iso(start + 7200) });

    expect((await discord.patch(bot, `/guilds/${guild.id}/scheduled-events/${id}`, { status: 2 })).body.status).toBe(2);
    expect((await discord.patch(bot, `/guilds/${guild.id}/scheduled-events/${id}`, { status: 4 })).status).toBe(400);
    expect((await discord.patch(bot, `/guilds/${guild.id}/scheduled-events/${id}`, { status: 3 })).body.status).toBe(3);
    expect((await discord.get(bot, `/guilds/${guild.id}/scheduled-events/${id}`)).body).toMatchObject({ code: 10070 });

    const other = (await discord.post(bot, `/guilds/${guild.id}/scheduled-events`, {
      name: 'Later', entity_type: 3, entity_metadata: { location: 'Online' }, scheduled_start_time: iso(start), scheduled_end_time: iso(start + 60),
    })).body;
    expect((await discord.patch(bot, `/guilds/${guild.id}/scheduled-events/${other.id}`, { status: 4 })).body.status).toBe(4);
    const third = (await discord.post(bot, `/guilds/${guild.id}/scheduled-events`, {
      name: 'Gone', entity_type: 3, entity_metadata: { location: 'Online' }, scheduled_start_time: iso(start), scheduled_end_time: iso(start + 60),
    })).body;
    expect((await discord.delete(bot, `/guilds/${guild.id}/scheduled-events/${third.id}`)).status).toBe(204);
    expect((await discord.get(bot, `/guilds/${guild.id}/scheduled-events`)).body).toEqual([]);
  });

  it("refuses stage channels and what its permissions don't allow", async () => {
    const { owner, guild, lounge, bot } = await setUp(P.VIEW_CHANNEL);
    // @everyone gives bots Create Events, so take it away.
    const everyone = (await api.get(owner, `/guilds/${guild.id}`)).body.roles.find((r) => r.is_everyone);
    await request(app).patch(`/api/guilds/${guild.id}/roles/${everyone.id}`).set(authed(owner)).send({ permissions: everyone.permissions & ~P.CREATE_EVENTS });
    const stage = await discord.post(bot, `/guilds/${guild.id}/scheduled-events`, { name: 'x', entity_type: 1, scheduled_start_time: iso(soon()) });
    expect(stage.status).toBe(400);
    const res = await discord.post(bot, `/guilds/${guild.id}/scheduled-events`, {
      name: 'x', entity_type: 2, channel_id: String(lounge.id), scheduled_start_time: iso(soon()),
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(50013);
  });

  it('takes a cover as image data, and repeating rules', async () => {
    const { guild, bot } = await setUp();
    const png = await sharp({ create: { width: 40, height: 16, channels: 3, background: '#336699' } }).png().toBuffer();
    // A Monday at 18:00 UTC, at least a day away.
    let start = soon() + 86400;
    while (new Date(start * 1000).getUTCDay() !== 1) start += 86400;
    start = Math.floor(start / 86400) * 86400 + 18 * 3600;
    const res = await discord.post(bot, `/guilds/${guild.id}/scheduled-events`, {
      name: 'Weekly', entity_type: 3, entity_metadata: { location: 'Online' }, scheduled_start_time: iso(start), scheduled_end_time: iso(start + 3600),
      image: `data:image/png;base64,${png.toString('base64')}`,
      recurrence_rule: { start: iso(start), frequency: 2, interval: 1, by_weekday: [0] },
    });
    expect(res.status).toBe(200);
    expect(res.body.image).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.recurrence_rule).toMatchObject({ start: iso(start), frequency: 2, interval: 1, by_weekday: [0], by_n_weekday: null });
    expect([...objects.keys()].some((k) => k.startsWith('uploads/') && k.endsWith('.webp'))).toBe(true);
    const cdn = await request(app).get(`/api/cdn/guild-events/${res.body.id}/${res.body.image}.png`);
    expect(cdn.status).toBe(302);
    expect(cdn.headers.location).toMatch(/\/uploads\/.+\.webp$/);
    const bad = await discord.post(bot, `/guilds/${guild.id}/scheduled-events`, {
      name: 'Bad', entity_type: 3, entity_metadata: { location: 'x' }, scheduled_start_time: iso(start), scheduled_end_time: iso(start + 60),
      recurrence_rule: { frequency: 2, interval: 5, by_weekday: [0] },
    });
    expect(bad.status).toBe(400);
  });
});

// ---- The gateway ----

const server = http.createServer(app);
attachWebSocketServer(server);
const port = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
afterAll(() => new Promise((resolve) => server.close(resolve)));

async function connectGateway() {
  const ws = new WebSocket(`ws://127.0.0.1:${await port}/api/gateway?v=10&encoding=json`);
  const received = [];
  const waiters = [];
  ws.on('message', (data) => {
    const payload = JSON.parse(data.toString());
    received.push(payload);
    for (const w of [...waiters]) if (w.test(payload)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(payload); }
  });
  const next = (test) => {
    const found = received.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      waiters.push({ test, resolve });
      setTimeout(() => reject(new Error('Timed out waiting for a gateway payload')), 5000);
    });
  };
  await new Promise((resolve) => ws.on('open', resolve));
  return { ws, received, next, send: (payload) => ws.send(JSON.stringify(payload)) };
}
const dispatch = (t) => (p) => p.op === 0 && p.t === t;

describe('scheduled events on the gateway', () => {
  it('lists them in GUILD_CREATE and sends their changes with GUILD_SCHEDULED_EVENTS', async () => {
    const { owner, guild, bot } = await setUp();
    const start = soon();
    const before = (await api.post(owner, `/guilds/${guild.id}/events`, {
      name: 'Existing', entityType: 'external', location: 'Hall', startTime: start, endTime: start + 60,
    })).body;
    const gw = await connectGateway();
    await gw.next((p) => p.op === 10);
    gw.send({ op: 2, d: { token: bot.token, intents: 1 | (1 << 16), properties: { os: 'linux', browser: 'test', device: 'test' } } });
    const created = await gw.next(dispatch('GUILD_CREATE'));
    expect(created.d.guild_scheduled_events).toEqual([expect.objectContaining({ id: String(before.id), name: 'Existing', entity_type: 3 })]);

    const event = (await api.post(owner, `/guilds/${guild.id}/events`, {
      name: 'New', entityType: 'external', location: 'Hall', startTime: start, endTime: start + 60,
    })).body;
    expect((await gw.next(dispatch('GUILD_SCHEDULED_EVENT_CREATE'))).d).toMatchObject({ id: String(event.id), name: 'New', creator_id: String(owner.id) });
    await request(app).patch(`/api/guild-events/${event.id}`).set(authed(owner)).send({ name: 'Renamed' });
    expect((await gw.next(dispatch('GUILD_SCHEDULED_EVENT_UPDATE'))).d).toMatchObject({ id: String(event.id), name: 'Renamed' });
    await api.put(owner, `/guild-events/${before.id}/interest`);
    await request(app).delete(`/api/guild-events/${before.id}/interest`).set(authed(owner));
    expect((await gw.next(dispatch('GUILD_SCHEDULED_EVENT_USER_REMOVE'))).d).toEqual({
      guild_scheduled_event_id: String(before.id), user_id: String(owner.id), guild_id: String(guild.id),
    });
    expect(gw.received.some(dispatch('GUILD_SCHEDULED_EVENT_USER_ADD'))).toBe(false); // already interested: its creator
    await request(app).delete(`/api/guild-events/${event.id}`).set(authed(owner));
    expect((await gw.next(dispatch('GUILD_SCHEDULED_EVENT_DELETE'))).d).toMatchObject({ id: String(event.id), status: 4 });
    gw.ws.close(1000);
  });
});
