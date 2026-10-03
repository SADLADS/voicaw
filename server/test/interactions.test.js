import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const http = require('http');
const WebSocket = require('ws');
const app = require('../index.js');
const { attachWebSocketServer } = require('../sockets.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { toDiscordPermissions } = require('../discord.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'ia-user') {
  const username = `${prefix}-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-interactions-1');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-interactions-1');
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
};
const botAuth = (bot) => ({ Authorization: `Bot ${bot.token}` });
const discord = {
  get: (bot, url) => request(app).get(`/api/v10${url}`).set(botAuth(bot)),
  post: (bot, url, body = {}) => request(app).post(`/api/v10${url}`).set(botAuth(bot)).send(body),
  put: (bot, url, body) => request(app).put(`/api/v10${url}`).set(botAuth(bot)).send(body),
  patch: (bot, url, body = {}) => request(app).patch(`/api/v10${url}`).set(botAuth(bot)).send(body),
  delete: (bot, url) => request(app).delete(`/api/v10${url}`).set(botAuth(bot)),
};
// The interaction's own endpoints (no bot token, as Discord's).
const hook = {
  callback: (i, body, query = '') => request(app).post(`/api/v10/interactions/${i.id}/${i.token}/callback${query}`).send(body),
  post: (i, body) => request(app).post(`/api/v10/webhooks/${i.application_id}/${i.token}`).send(body),
  patch: (i, id, body) => request(app).patch(`/api/v10/webhooks/${i.application_id}/${i.token}/messages/${id}`).send(body),
  get: (i, id) => request(app).get(`/api/v10/webhooks/${i.application_id}/${i.token}/messages/${id}`),
  delete: (i, id) => request(app).delete(`/api/v10/webhooks/${i.application_id}/${i.token}/messages/${id}`),
};

// A user's app socket, collecting events.
function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now() } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

// A guild (owner + member), its #general, and a bot added with `permissions` (ours).
async function setUp(permissions = P.VIEW_CHANNEL | P.SEND_MESSAGES) {
  const owner = await makeUser('ia-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Commands' })).body;
  const member = await makeUser('ia-member');
  await api.post(member, `/invites/${(await api.post(owner, `/guilds/${guild.id}/invites`)).body.code}`);
  const created = await api.post(owner, '/applications', { name: 'Slash Bot' });
  const bot = { id: created.body.id, token: created.body.token };
  await api.post(owner, '/oauth2/authorize', { client_id: bot.id, guild_id: guild.id, permissions: toDiscordPermissions(permissions) });
  return { owner, member, guild, general: guild.channels[0], bot };
}

// ---- A bot connected to the gateway, answering interactions with `handler` ----

const server = http.createServer(app);
attachWebSocketServer(server);
const port = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
afterAll(() => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
}));

async function connectBot(bot, handler = () => {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${await port}/api/gateway?v=10&encoding=json`);
  const received = [];
  const ready = new Promise((resolve) => {
    ws.on('message', async (raw) => {
      const p = JSON.parse(raw.toString());
      if (p.op === 10) ws.send(JSON.stringify({ op: 2, d: { token: bot.token, intents: 1 | 512 } }));
      if (p.t === 'READY') resolve();
      if (p.t === 'INTERACTION_CREATE') {
        received.push(p.d);
        await handler(p.d);
      }
    });
  });
  await ready;
  return { received, close: () => ws.close(1000) };
}


describe('application commands', () => {
  it('are made, replaced, overwritten, changed and deleted, with Discord\'s checks', async () => {
    const { guild, bot } = await setUp();
    const made = await discord.post(bot, `/applications/${bot.id}/commands`, {
      name: 'weather', description: 'Today\'s weather', options: [{ type: 3, name: 'city', description: 'Where', required: true }],
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ type: 1, name: 'weather', application_id: String(bot.id), options: [{ name: 'city', required: true }], default_member_permissions: null });
    // The same name again replaces it (same id).
    const again = await discord.post(bot, `/applications/${bot.id}/commands`, { name: 'weather', description: 'Changed' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(made.body.id);

    // Discord's checks.
    expect((await discord.post(bot, `/applications/${bot.id}/commands`, { name: 'Bad Name', description: 'x' })).body).toMatchObject({ code: 50035, errors: { name: expect.any(Object) } });
    expect((await discord.post(bot, `/applications/${bot.id}/commands`, {
      name: 'order', description: 'x', options: [{ type: 3, name: 'a', description: 'a' }, { type: 3, name: 'b', description: 'b', required: true }],
    })).body).toMatchObject({ code: 50035 });
    expect((await discord.post(bot, `/applications/${bot.id}/commands`, { type: 2, name: 'Wave at', description: 'no' })).status).toBe(400);

    // Bulk overwrite keeps ids of the same name; others go.
    const set = await discord.put(bot, `/applications/${bot.id}/commands`, [
      { name: 'weather', description: 'Weather' },
      { type: 2, name: 'Wave at' },
      { type: 3, name: 'Quote', default_member_permissions: '0' },
    ]);
    expect(set.body.map((c) => c.name)).toEqual(['weather', 'Wave at', 'Quote']);
    expect(set.body[0].id).toBe(made.body.id);
    expect(set.body[2].default_member_permissions).toBe('0');
    expect((await discord.get(bot, `/applications/${bot.id}/commands`)).body).toHaveLength(3);

    const changed = await discord.patch(bot, `/applications/${bot.id}/commands/${made.body.id}`, { description: 'Forecast', default_member_permissions: toDiscordPermissions(P.MANAGE_MESSAGES) });
    expect(changed.body).toMatchObject({ name: 'weather', description: 'Forecast', default_member_permissions: toDiscordPermissions(P.MANAGE_MESSAGES) });
    expect((await discord.delete(bot, `/applications/${bot.id}/commands/${made.body.id}`)).status).toBe(204);
    expect((await discord.get(bot, `/applications/${bot.id}/commands/${made.body.id}`)).body).toMatchObject({ code: 10063 });

    // Guild commands: only in its own guilds; another bot's application isn't its.
    expect((await discord.post(bot, `/applications/${bot.id}/guilds/${guild.id}/commands`, { name: 'local', description: 'Here only' })).status).toBe(201);
    expect((await discord.get(bot, `/applications/${bot.id}/guilds/999999/commands`)).status).toBe(403);
    expect((await discord.get(bot, `/applications/12345/commands`)).status).toBe(403);
  });

  it('show people only the ones they may use there', async () => {
    const { owner, member, guild, general, bot } = await setUp();
    await discord.put(bot, `/applications/${bot.id}/commands`, [
      { name: 'ping', description: 'Pong' },
      { name: 'purge', description: 'Mods only', default_member_permissions: toDiscordPermissions(P.MANAGE_MESSAGES) },
      { name: 'spicy', description: 'NSFW', nsfw: true },
    ]);
    await discord.put(bot, `/applications/${bot.id}/guilds/${guild.id}/commands`, [{ name: 'local', description: 'Here' }]);
    const forMember = (await api.get(member, `/channels/${general.id}/commands`)).body;
    expect(forMember.map((c) => c.name).sort()).toEqual(['local', 'ping']);
    expect(forMember[0]).toMatchObject({ bot: { id: bot.id, name: 'Slash Bot' } });
    expect((await api.get(owner, `/channels/${general.id}/commands`)).body.map((c) => c.name).sort()).toEqual(['local', 'ping', 'purge']);
    // Kicked: its commands go with it.
    await api.patch(owner, `/guilds/${guild.id}`, {});
    await request(app).delete(`/api/guilds/${guild.id}/members/${bot.id}`).set(authed(owner));
    expect((await api.get(member, `/channels/${general.id}/commands`)).body).toEqual([]);
  });
});

describe('interactions', () => {
  it('delivers a slash command with its options and resolved users; the reply says who used it', async () => {
    const { owner, member, general, bot } = await setUp();
    const [cmd] = (await discord.put(bot, `/applications/${bot.id}/commands`, [{
      name: 'hug', description: 'Hug someone',
      options: [{ type: 6, name: 'who', description: 'Who', required: true }, { type: 4, name: 'times', description: 'How often', min_value: 1, max_value: 5 }],
    }])).body;
    const gw = await connectBot(bot, (i) => hook.callback(i, {
      type: 4, data: { content: `Hug x${i.data.options[1].value}!`, components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Hug back', custom_id: 'back' }] }] },
    }));
    const events = listen(owner);
    const used = await api.post(member, `/channels/${general.id}/command-interactions`, {
      command_id: cmd.id, options: [{ name: 'who', type: 6, value: String(owner.id) }, { name: 'times', type: 4, value: 3 }],
    });
    expect(used.body).toEqual({ ok: true });
    const [i] = gw.received;
    expect(i).toMatchObject({
      type: 2, application_id: String(bot.id), channel_id: String(general.id),
      data: { id: cmd.id, name: 'hug', type: 1, options: [{ name: 'who', value: String(owner.id) }, { name: 'times', value: 3 }] },
      member: { user: { id: String(member.id) } },
    });
    expect(i.data.resolved.users[String(owner.id)]).toMatchObject({ username: owner.username });
    expect(i.token).toMatch(/^aW50ZXJhY3Rpb246/);

    const posted = events.find((e) => e.type === 'guild_message_new').message;
    expect(posted).toMatchObject({ content: 'Hug x3!', sender_id: bot.id, interaction: { name: 'hug', user_id: member.id }, components: [{ type: 1 }] });
    const object = (await discord.get(bot, `/channels/${general.id}/messages/${posted.id}`)).body;
    expect(object).toMatchObject({ type: 20, interaction_metadata: { id: i.id, type: 2, user: { id: String(member.id) } }, interaction: { name: 'hug' } });

    // Bad options never reach the bot.
    expect((await api.post(member, `/channels/${general.id}/command-interactions`, { command_id: cmd.id, options: [{ name: 'times', type: 4, value: 9 }] })).status).toBe(400);
    // Answering twice is refused.
    expect((await hook.callback(i, { type: 4, data: { content: 'again' } })).body).toMatchObject({ code: 40060 });
    gw.close();
  });

  it('keeps ephemeral replies to the person who used it, and lets the bot defer, follow up and edit', async () => {
    const { owner, member, general, bot } = await setUp();
    const [cmd] = (await discord.put(bot, `/applications/${bot.id}/commands`, [{ name: 'secret', description: 'Shh' }])).body;
    let interaction;
    const gw = await connectBot(bot, (i) => { interaction = i; return hook.callback(i, { type: 5, data: { flags: 64 } }); });
    const mine = listen(member);
    const theirs = listen(owner);
    expect((await api.post(member, `/channels/${general.id}/command-interactions`, { command_id: cmd.id })).body).toEqual({ ok: true });
    const thinking = mine.find((e) => e.type === 'guild_ephemeral_message').message;
    expect(thinking).toMatchObject({ ephemeral: true, flags: 128, sender_id: bot.id });

    // The first follow-up after "thinking…" becomes it.
    const filled = await hook.post(interaction, { content: 'Only for you' });
    expect(filled.body).toMatchObject({ id: String(thinking.id), content: 'Only for you', flags: 64 });
    expect(mine.find((e) => e.type === 'guild_ephemeral_edit').message.content).toBe('Only for you');
    const second = await hook.post(interaction, { content: 'Everyone sees this' });
    expect(second.body.flags & 64).toBe(0);
    expect((await hook.patch(interaction, '@original', { content: 'Edited secret' })).body.content).toBe('Edited secret');
    expect((await hook.get(interaction, second.body.id)).body.content).toBe('Everyone sees this');

    // Nobody else ever saw the ephemeral one, and it isn't in the channel.
    expect(theirs.some((e) => String(e.type).startsWith('guild_ephemeral'))).toBe(false);
    const history = (await api.get(owner, `/channels/${general.id}/messages`)).body.map((m) => m.content);
    expect(history).toEqual(['Everyone sees this']);
    expect((await hook.delete(interaction, second.body.id)).status).toBe(204);
    gw.close();
  });

  it('delivers button clicks and select choices on its messages, and can update the message', async () => {
    const { member, general, bot } = await setUp();
    const gw = await connectBot(bot, (i) => (i.data.custom_id === 'count'
      ? hook.callback(i, { type: 7, data: { content: 'Clicked!', components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Done', custom_id: 'count', disabled: true }] }] } })
      : hook.callback(i, { type: 6 })));
    const msg = (await discord.post(bot, `/channels/${general.id}/messages`, {
      content: 'Pick',
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: 'Count', custom_id: 'count' }, { type: 2, style: 5, label: 'Site', url: 'https://example.com' }] },
        { type: 1, components: [{ type: 3, custom_id: 'fruit', options: [{ label: 'Apple', value: 'apple' }, { label: 'Pear', value: 'pear' }], max_values: 2 }] },
      ],
    })).body;
    expect(msg.components).toHaveLength(2);

    expect((await api.post(member, `/guild-messages/${msg.id}/component-interactions`, { custom_id: 'fruit', values: ['pear', 'apple'] })).body).toEqual({ ok: true });
    expect(gw.received[0]).toMatchObject({ type: 3, data: { custom_id: 'fruit', component_type: 3, values: ['pear', 'apple'] }, message: { id: msg.id } });
    expect((await api.post(member, `/guild-messages/${msg.id}/component-interactions`, { custom_id: 'fruit', values: ['plum'] })).status).toBe(400);
    expect((await api.post(member, `/guild-messages/${msg.id}/component-interactions`, { custom_id: 'nope' })).status).toBe(400);

    expect((await api.post(member, `/guild-messages/${msg.id}/component-interactions`, { custom_id: 'count' })).body).toEqual({ ok: true });
    const after = (await discord.get(bot, `/channels/${general.id}/messages/${msg.id}`)).body;
    expect(after).toMatchObject({ content: 'Clicked!', components: [{ components: [{ label: 'Done', disabled: true }] }] });
    // Disabled now.
    expect((await api.post(member, `/guild-messages/${msg.id}/component-interactions`, { custom_id: 'count' })).status).toBe(400);
    // Bad components are refused when sending.
    expect((await discord.post(bot, `/channels/${general.id}/messages`, { components: [{ type: 2, style: 1, label: 'x', custom_id: 'y' }] })).body).toMatchObject({ code: 50035 });
    gw.close();
  });

  it('opens a form and delivers what was filled in', async () => {
    const { member, general, bot } = await setUp();
    const [cmd] = (await discord.put(bot, `/applications/${bot.id}/commands`, [{ name: 'feedback', description: 'Tell us' }])).body;
    const gw = await connectBot(bot, (i) => (i.type === 2
      ? hook.callback(i, { type: 9, data: { custom_id: 'fb', title: 'Feedback', components: [
        { type: 1, components: [{ type: 4, custom_id: 'text', label: 'What do you think?', style: 2, min_length: 3 }] },
        { type: 18, label: 'Mood', component: { type: 3, custom_id: 'mood', options: [{ label: 'Happy', value: 'happy' }, { label: 'Sad', value: 'sad' }] } },
      ] } })
      : hook.callback(i, { type: 4, data: { content: `Thanks: ${i.data.components[0].components[0].value}` } })));
    const opened = await api.post(member, `/channels/${general.id}/command-interactions`, { command_id: cmd.id });
    expect(opened.body.modal).toMatchObject({ id: expect.any(String), title: 'Feedback', custom_id: 'fb', bot: { name: 'Slash Bot' } });
    expect((await api.post(member, `/modals/${opened.body.modal.id}`, { answers: { text: 'no' } })).status).toBe(400);
    const sent = await api.post(member, `/modals/${opened.body.modal.id}`, { answers: { text: 'Lovely app', mood: ['happy'] } });
    expect(sent.body).toEqual({ ok: true });
    expect(gw.received[1]).toMatchObject({ type: 5, data: { custom_id: 'fb', components: [
      { type: 1, components: [{ custom_id: 'text', value: 'Lovely app' }] },
      { type: 18, component: { custom_id: 'mood', values: ['happy'] } },
    ] } });
    // A form is used once.
    expect((await api.post(member, `/modals/${opened.body.modal.id}`, { answers: { text: 'again', mood: ['sad'] } })).status).toBe(404);
    gw.close();
  });

  it('asks for autocomplete suggestions, and runs context-menu commands on a user', async () => {
    const { owner, member, general, bot } = await setUp();
    const [search, wave] = (await discord.put(bot, `/applications/${bot.id}/commands`, [
      { name: 'city', description: 'Find a city', options: [{ type: 3, name: 'name', description: 'Name', required: true, autocomplete: true }] },
      { type: 2, name: 'Wave' },
    ])).body;
    const gw = await connectBot(bot, (i) => (i.type === 4
      ? hook.callback(i, { type: 8, data: { choices: [{ name: 'London', value: 'london' }, { name: 'Lisbon', value: 'lisbon' }] } })
      : hook.callback(i, { type: 4, data: { content: `👋 <@${i.data.target_id}>` } })));
    const suggested = await api.post(member, `/channels/${general.id}/autocomplete`, { command_id: search.id, options: [{ name: 'name', type: 3, value: 'L', focused: true }] });
    expect(suggested.body.choices.map((c) => c.value)).toEqual(['london', 'lisbon']);
    expect(gw.received[0]).toMatchObject({ type: 4, data: { options: [{ name: 'name', value: 'L', focused: true }] } });

    expect((await api.post(member, `/channels/${general.id}/command-interactions`, { command_id: wave.id, target_id: String(owner.id) })).body).toEqual({ ok: true });
    expect(gw.received[1]).toMatchObject({ type: 2, data: { type: 2, name: 'Wave', target_id: String(owner.id) } });
    gw.close();
  });

  it('answers callbacks and follow-ups with rate limits on (no bot token there)', async () => {
    const config = require('../config.js');
    const { member, general, bot } = await setUp();
    const [cmd] = (await discord.put(bot, `/applications/${bot.id}/commands`, [{ name: 'limited', description: 'x' }])).body;
    let interaction;
    const gw = await connectBot(bot, async (i) => {
      interaction = i;
      const res = await hook.callback(i, { type: 4, data: { content: 'hi' } });
      i.status = res.status;
    });
    config.rateLimitsEnabled = true;
    try {
      expect((await api.post(member, `/channels/${general.id}/command-interactions`, { command_id: cmd.id })).body).toEqual({ ok: true });
      expect(interaction.status).toBe(204);
      const followup = await hook.post(interaction, { content: 'more' });
      expect(followup.status).toBe(200);
      expect(followup.headers['x-ratelimit-limit']).toBeDefined();
    } finally {
      config.rateLimitsEnabled = false;
      gw.close();
    }
  });

  it("says when the bot isn't connected or doesn't answer in time", async () => {
    const { member, general, bot } = await setUp();
    const [cmd] = (await discord.put(bot, `/applications/${bot.id}/commands`, [{ name: 'slow', description: 'Slow' }])).body;
    const offline = await api.post(member, `/channels/${general.id}/command-interactions`, { command_id: cmd.id });
    expect(offline.status).toBe(504);
    const gw = await connectBot(bot, () => {}); // never answers
    const started = Date.now();
    const late = await api.post(member, `/channels/${general.id}/command-interactions`, { command_id: cmd.id });
    expect(late.status).toBe(504);
    expect(late.body.error).toBe('The application did not respond');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    // Answering after that is too late.
    expect((await hook.callback(gw.received[0], { type: 4, data: { content: 'late' } })).body).toMatchObject({ code: 10062 });
    gw.close();
  });
});
