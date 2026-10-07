import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { toDiscordPermissions } = require('../discord.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'jl-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-joinlog-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};
const discord = {
  get: (bot, url) => request(app).get(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }),
};

function connect(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now() } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

async function setUp() {
  const owner = await makeUser('jl-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Join log' })).body;
  const log = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'arrivals', type: 'text' })).body;
  return { owner, guild, general: guild.channels[0], log };
}

async function join(guild, owner, user) {
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  return api.post(user, `/invites/${invite.body.code}`);
}

const logRows = (channelId) => db.all('SELECT sender_id, system, content FROM guild_messages WHERE channel_id = ? AND system IS NOT NULL ORDER BY id', [channelId]);

describe('join log', () => {
  it('is off by default: joining posts nothing', async () => {
    const { owner, guild, general, log } = await setUp();
    expect(guild.join_log).toEqual({ channel_id: null, leaves: false });
    await join(guild, owner, await makeUser());
    expect(await logRows(general.id)).toEqual([]);
    expect(await logRows(log.id)).toEqual([]);
  });

  it('posts joins in the chosen channel, read for the joiner and new for everyone else', async () => {
    const { owner, guild, log } = await setUp();
    const res = await api.patch(owner, `/guilds/${guild.id}`, { joinLog: { channelId: log.id } });
    expect(res.status).toBe(200);
    expect(res.body.join_log).toEqual({ channel_id: log.id, leaves: false });

    const ownerEvents = connect(owner);
    const alice = await makeUser('jl-alice');
    expect((await join(guild, owner, alice)).status).toBe(201);
    expect(await logRows(log.id)).toEqual([{ sender_id: alice.id, system: 'member_join', content: '' }]);
    const event = ownerEvents.find((e) => e.type === 'guild_message_new');
    expect(event.message).toMatchObject({ channel_id: log.id, sender_id: alice.id, system: 'member_join', sender_username: alice.username });

    const history = (await api.get(alice, `/channels/${log.id}/messages`)).body;
    expect(JSON.stringify(history)).toContain('member_join');
    const read = await db.get('SELECT last_read_id FROM guild_channel_reads WHERE user_id = ? AND channel_id = ?', [alice.id, log.id]);
    expect(read.last_read_id).toBe(event.message.id);

    // The audit log says what changed.
    const audit = await db.get("SELECT details FROM guild_audit_log WHERE guild_id = ? AND action = 'guild_update'", [guild.id]);
    expect(JSON.parse(audit.details)).toEqual({ changes: { join_log: [null, 'arrivals'] } });
  });

  it('posts leaves, kicks and bans alike only when asked', async () => {
    const { owner, guild, log } = await setUp();
    await api.patch(owner, `/guilds/${guild.id}`, { joinLog: { channelId: log.id } });
    const [a, b, c, d] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    for (const user of [a, b, c, d]) await join(guild, owner, user);
    await api.delete(a, `/guilds/${guild.id}/members/me`);
    expect((await logRows(log.id)).filter((r) => r.system === 'member_leave')).toEqual([]);

    expect((await api.patch(owner, `/guilds/${guild.id}`, { joinLog: { leaves: true } })).body.join_log)
      .toEqual({ channel_id: log.id, leaves: true });
    await api.delete(b, `/guilds/${guild.id}/members/me`);
    await api.delete(owner, `/guilds/${guild.id}/members/${c.id}`);
    await api.put(owner, `/guilds/${guild.id}/bans/${d.id}`);
    const leaves = (await logRows(log.id)).filter((r) => r.system === 'member_leave');
    expect(leaves.map((r) => r.sender_id)).toEqual([b.id, c.id, d.id]);
  });

  it('only takes a text channel of the guild, needs Manage Guild, and goes with its channel', async () => {
    const { owner, guild, log } = await setUp();
    const other = (await api.post(owner, '/guilds', { name: 'Other' })).body;
    const voice = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Talk', type: 'voice' })).body;
    for (const channelId of [other.channels[0].id, voice.id, 'x', 999999]) {
      expect((await api.patch(owner, `/guilds/${guild.id}`, { joinLog: { channelId } })).status).toBe(400);
    }
    expect((await api.patch(owner, `/guilds/${guild.id}`, { joinLog: { leaves: 'yes' } })).status).toBe(400);
    expect((await api.patch(owner, `/guilds/${guild.id}`, { joinLog: 'on' })).status).toBe(400);

    const member = await makeUser();
    await join(guild, owner, member);
    expect((await api.patch(member, `/guilds/${guild.id}`, { joinLog: { channelId: log.id } })).status).toBe(403);

    await api.patch(owner, `/guilds/${guild.id}`, { joinLog: { channelId: log.id, leaves: true } });
    await api.delete(owner, `/guilds/${guild.id}/channels/${log.id}`);
    expect((await api.get(owner, `/guilds/${guild.id}`)).body.join_log).toEqual({ channel_id: null, leaves: true });

    // Off again with null.
    const general = guild.channels[0];
    await api.patch(owner, `/guilds/${guild.id}`, { joinLog: { channelId: general.id } });
    expect((await api.patch(owner, `/guilds/${guild.id}`, { joinLog: { channelId: null } })).body.join_log.channel_id).toBe(null);
  });

  it("is left out of search, and bots see it as Discord's system channel and join messages", async () => {
    const { owner, guild, log } = await setUp();
    await api.patch(owner, `/guilds/${guild.id}`, { joinLog: { channelId: log.id } });
    const res = await api.post(owner, '/applications', { name: 'Greeter' });
    const bot = { id: res.body.id, token: res.body.token };
    const added = await api.post(owner, '/oauth2/authorize', {
      client_id: String(bot.id), guild_id: guild.id, permissions: toDiscordPermissions(P.VIEW_CHANNEL | P.SEND_MESSAGES),
    });
    expect(added.status).toBe(201);
    const alice = await makeUser();
    await join(guild, owner, alice);

    expect((await discord.get(bot, `/guilds/${guild.id}`)).body.system_channel_id).toBe(String(log.id));
    const messages = (await discord.get(bot, `/channels/${log.id}/messages`)).body;
    expect(messages.map((m) => [m.type, m.author.id])).toEqual([[7, String(alice.id)], [7, String(bot.id)]]);

    const search = await api.get(owner, `/guilds/${guild.id}/messages/search?author_id=${alice.id}`);
    expect(search.status).toBe(200);
    expect(search.body.total_results).toBe(0);
  });
});
