import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { toDiscordPermissions } = require('../discord.js');
const levels = require('../guildLevels.js');
const voice = require('../voice.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'lvl-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-levels-123';
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
const botAuth = (bot) => ({ Authorization: `Bot ${bot.token}` });
const discord = {
  get: (bot, url) => request(app).get(`/api/v10${url}`).set(botAuth(bot)),
  post: (bot, url, body = {}) => request(app).post(`/api/v10${url}`).set(botAuth(bot)).send(body),
  patch: (bot, url, body = {}) => request(app).patch(`/api/v10${url}`).set(botAuth(bot)).send(body),
};

function connect(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now() } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

// A guild with an owner and two members, and its #general.
async function setUp({ levelsOn = true } = {}) {
  const owner = await makeUser('l-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Levels' })).body;
  const members = [];
  for (let i = 0; i < 2; i++) {
    const user = await makeUser('l-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  // Levels are off until a guild turns them on.
  if (levelsOn) {
    await api.patch(owner, `/guilds/${guild.id}/levels`, { enabled: true });
    guild.levels = (await api.get(owner, `/guilds/${guild.id}`)).body.levels;
  }
  return { owner, members, guild, general: guild.channels[0] };
}

const say = (user, channelId, content, extra = {}) => api.post(user, `/channels/${channelId}/messages`, { content, ...extra });
const xpOf = async (guild, user) => (await db.get('SELECT xp FROM guild_member_xp WHERE guild_id = ? AND user_id = ?', [guild.id, user.id]))?.xp ?? 0;
const configure = (user, guild, patch) => api.patch(user, `/guilds/${guild.id}/levels`, patch);

describe('levels', () => {
  it('are off by default, and once on messages earn XP once per cooldown', async () => {
    const { owner, members: [alice], guild, general } = await setUp({ levelsOn: false });
    expect(guild.levels).toMatchObject({ enabled: false, xpPerLevel: 100, levelShort: '', showInMemberList: true });
    await say(alice, general.id, 'nothing earns XP yet');
    expect(await xpOf(guild, alice)).toBe(0);

    await configure(owner, guild, { enabled: true });
    expect(guild.levels.sources.message).toEqual({ enabled: true, xp: 10 });
    expect(guild.levels.sources.voiceMinute.enabled).toBe(false);

    await say(alice, general.id, 'hello');
    await say(alice, general.id, 'hello again, too soon to count');
    expect(await xpOf(guild, alice)).toBe(10);

    await configure(owner, guild, { messageCooldown: 0 });
    await say(alice, general.id, 'now it counts');
    expect(await xpOf(guild, alice)).toBe(20);
  });

  it('give replies to their parent\'s author, never for replying to yourself', async () => {
    const { owner, members: [alice, bob], guild, general } = await setUp();
    await configure(owner, guild, { messageCooldown: 0, sources: { message: { enabled: false } } });
    const first = (await say(alice, general.id, 'question?')).body;
    await say(alice, general.id, 'adding to it', { replyTo: first.id });
    expect(await xpOf(guild, alice)).toBe(0);
    await say(bob, general.id, 'answer', { replyTo: first.id });
    expect(await xpOf(guild, alice)).toBe(5);
  });

  it('give reactions once per person and message, not your own or poll votes', async () => {
    const { owner, members: [alice, bob], guild, general } = await setUp();
    await configure(owner, guild, { sources: { message: { enabled: false }, reactionGiven: { enabled: true, xp: 1 } } });
    const message = (await say(alice, general.id, 'react to me')).body;
    await api.post(alice, `/guild-messages/${message.id}/reactions`, { emoji: '👍' });
    expect(await xpOf(guild, alice)).toBe(0);

    const reaction = (await api.post(bob, `/guild-messages/${message.id}/reactions`, { emoji: '👍' })).body;
    await api.post(bob, `/guild-messages/${message.id}/reactions`, { emoji: '🎉' });
    expect(await xpOf(guild, alice)).toBe(5);
    expect(await xpOf(guild, bob)).toBe(1);
    // Taking it back and reacting again earns nothing more.
    await api.delete(bob, `/guild-reactions/${reaction.id}`);
    await api.post(bob, `/guild-messages/${message.id}/reactions`, { emoji: '👍' });
    expect(await xpOf(guild, alice)).toBe(5);
    expect(await xpOf(guild, bob)).toBe(1);
  });

  it('earn nothing when turned off', async () => {
    const { owner, members: [alice], guild, general } = await setUp();
    expect((await configure(owner, guild, { enabled: false })).body.enabled).toBe(false);
    await say(alice, general.id, 'quiet');
    expect(await xpOf(guild, alice)).toBe(0);
    expect((await api.get(alice, `/guilds/${guild.id}`)).body.levels.enabled).toBe(false);
  });

  it('settings need Manage Guild, are checked, and are in the audit log', async () => {
    const { owner, members: [alice], guild } = await setUp();
    expect((await configure(alice, guild, { xpPerLevel: 1 })).status).toBe(403);
    expect((await configure(owner, guild, { xpPerLevel: 0 })).status).toBe(400);
    expect((await configure(owner, guild, { levelShort: 'x'.repeat(13) })).status).toBe(400);
    expect((await configure(owner, guild, { sources: { flying: { xp: 1 } } })).status).toBe(400);
    expect((await configure(owner, guild, { sources: { message: { xp: -1 } } })).status).toBe(400);

    const res = await configure(owner, guild, { xpPerLevel: 1, xpName: 'Points', levelName: 'Rank', levelShort: ' rk ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xpPerLevel: 1, xpName: 'Points', levelName: 'Rank', levelShort: 'rk' });
    // Untouched sources keep their defaults.
    expect(res.body.sources.replyReceived).toEqual({ enabled: true, xp: 5 });

    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body;
    const entry = log.entries.find((e) => e.action === 'levels_update');
    expect(entry.details.changes.xpPerLevel).toEqual([100, 1]);
  });

  it('Manage Levels sets and adds XP and levels, and tells the guild', async () => {
    const { owner, members: [alice, bob], guild } = await setUp();
    const path = `/guilds/${guild.id}/levels/members/${bob.id}`;
    expect((await api.patch(alice, path, { level: 3 })).status).toBe(403);

    const role = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'XP staff', permissions: P.MANAGE_LEVELS })).body;
    await api.put(owner, `/guilds/${guild.id}/members/${alice.id}/roles`, { roleIds: [role.id] });
    const events = connect(bob);

    let res = await api.patch(alice, path, { level: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user_id: bob.id, xp: 300, level: 3, rank: 1 });
    expect(events.find((e) => e.type === 'guild_member_xp')).toMatchObject({ userId: bob.id, xp: 300, level: 3, previousLevel: 0 });

    res = await api.patch(alice, path, { addXp: 150 });
    expect(res.body).toMatchObject({ xp: 450, level: 4 });
    res = await api.patch(alice, path, { addLevels: -10 });
    expect(res.body).toMatchObject({ xp: 0, level: 0, rank: null });
    expect((await api.patch(alice, path, { xp: 5, level: 1 })).status).toBe(400);
    expect((await api.patch(alice, path, { xp: -5 })).status).toBe(400);
    expect((await api.patch(alice, `/guilds/${guild.id}/levels/members/999999`, { xp: 5 })).status).toBe(404);

    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body;
    expect(log.entries.some((e) => e.action === 'member_xp_update' && Number(e.target_id) === bob.id)).toBe(true);
  });

  it('has a leaderboard, ranks, and XP in the member list', async () => {
    const { owner, members: [alice, bob], guild } = await setUp();
    await api.patch(owner, `/guilds/${guild.id}/levels/members/${alice.id}`, { xp: 250 });
    await api.patch(owner, `/guilds/${guild.id}/levels/members/${bob.id}`, { xp: 900 });

    const board = (await api.get(alice, `/guilds/${guild.id}/levels/members`)).body;
    expect(board.map((r) => [r.user_id, r.xp, r.level, r.rank])).toEqual([[bob.id, 900, 9, 1], [alice.id, 250, 2, 2]]);
    expect((await api.get(bob, `/guilds/${guild.id}/levels/members/${alice.id}`)).body).toMatchObject({ level: 2, rank: 2 });

    const list = (await api.get(owner, `/guilds/${guild.id}/members`)).body;
    expect(list.find((m) => m.id === bob.id).xp).toBe(900);
    expect(list.find((m) => m.id === owner.id).xp).toBe(0);

    // A new XP per level changes everyone's level, not their XP.
    await configure(owner, guild, { xpPerLevel: 1000 });
    expect((await api.get(bob, `/guilds/${guild.id}/levels/members/${bob.id}`)).body).toMatchObject({ xp: 900, level: 0 });
  });

  it('can count threads, documents, completed tasks and mentions when turned on', async () => {
    const { owner, members: [alice, bob], guild, general } = await setUp();
    await configure(owner, guild, {
      sources: {
        message: { enabled: false },
        threadCreated: { enabled: true, xp: 7 },
        documentCreated: { enabled: true, xp: 11 },
        taskCompleted: { enabled: true, xp: 13 },
        mentionReceived: { enabled: true, xp: 3 },
      },
    });
    await api.post(alice, `/channels/${general.id}/threads`, { name: 'Plans' });
    expect(await xpOf(guild, alice)).toBe(7);

    const docs = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'docs', type: 'doc' })).body;
    await api.post(alice, `/channels/${docs.id}/documents`, { title: 'Notes', content: 'text' });
    expect(await xpOf(guild, alice)).toBe(18);

    const board = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'todo', type: 'list' })).body;
    const task = (await api.post(alice, `/channels/${board.id}/tasks`, { title: 'Do it' })).body;
    await api.patch(alice, `/tasks/${task.id}`, { completed: true });
    await api.patch(alice, `/tasks/${task.id}`, { completed: false });
    await api.patch(alice, `/tasks/${task.id}`, { completed: true });
    expect(await xpOf(guild, alice)).toBe(31);

    await say(bob, general.id, `hey <@${alice.id}>`);
    expect(await xpOf(guild, alice)).toBe(34);
  });

  it('gives voice XP to people in a channel together, not alone or deafened', async () => {
    const { owner, members: [alice, bob], guild } = await setUp();
    await configure(owner, guild, { sources: { voiceMinute: { enabled: true, xp: 2 } } });
    const state = (user, extra = {}) => ({ userId: user.id, guildId: guild.id, channelId: 424242, selfDeaf: false, ...extra });
    voice.states.set(alice.id, state(alice));
    await levels.awardVoiceMinute();
    expect(await xpOf(guild, alice)).toBe(0);

    voice.states.set(bob.id, state(bob, { selfDeaf: true }));
    await levels.awardVoiceMinute();
    expect(await xpOf(guild, alice)).toBe(2);
    expect(await xpOf(guild, bob)).toBe(0);
    voice.states.delete(alice.id);
    voice.states.delete(bob.id);
  });

  it('are deleted with the guild', async () => {
    const { owner, members: [alice], guild } = await setUp();
    await api.patch(owner, `/guilds/${guild.id}/levels/members/${alice.id}`, { xp: 50 });
    await api.delete(owner, `/guilds/${guild.id}`);
    expect(await db.get('SELECT 1 FROM guild_member_xp WHERE guild_id = ?', [guild.id])).toBeUndefined();
  });
});

describe('levels in the bot API', () => {
  async function withBot(permissions) {
    const setup = await setUp();
    const res = await api.post(setup.owner, '/applications', { name: 'Level Bot' });
    const bot = { id: res.body.id, token: res.body.token };
    const added = await api.post(setup.owner, '/oauth2/authorize', { client_id: String(bot.id), guild_id: setup.guild.id, permissions: toDiscordPermissions(permissions) });
    expect(added.status).toBe(201);
    return { ...setup, bot };
  }

  it('reads the settings and the leaderboard', async () => {
    const { owner, members: [alice], guild, bot } = await withBot(P.VIEW_CHANNEL | P.SEND_MESSAGES);
    const settings = (await discord.get(bot, `/guilds/${guild.id}/levels`)).body;
    expect(settings).toMatchObject({ enabled: true, xp_per_level: 100, xp_name: 'XP', level_name: 'Level', level_short_name: 'lvl' });
    expect(settings.sources.reply_received).toEqual({ enabled: true, xp: 5 });
    // Changing them needs Manage Guild.
    expect((await discord.patch(bot, `/guilds/${guild.id}/levels`, { xp_per_level: 1 })).status).toBe(403);

    await api.patch(owner, `/guilds/${guild.id}/levels/members/${alice.id}`, { xp: 120 });
    const board = (await discord.get(bot, `/guilds/${guild.id}/levels/members?limit=5`)).body;
    expect(board).toEqual([{ guild_id: String(guild.id), user_id: String(alice.id), xp: 120, level: 1, rank: 1, xp_per_level: 100 }]);
  });

  it('changes members\' XP and levels with Manage Levels; bots earn nothing by talking', async () => {
    const { members: [alice], guild, general, bot } = await withBot(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.MANAGE_LEVELS | P.MANAGE_GUILD);
    const path = `/guilds/${guild.id}/levels/members/${alice.id}`;
    let res = await discord.patch(bot, path, { add_levels: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user_id: String(alice.id), xp: 200, level: 2 });
    res = await discord.patch(bot, path, { add_xp: -50 });
    expect(res.body).toMatchObject({ xp: 150, level: 1 });
    res = await discord.patch(bot, path, { level: 10 });
    expect(res.body).toMatchObject({ xp: 1000, level: 10 });
    expect((await discord.get(bot, path)).body).toMatchObject({ xp: 1000, rank: 1 });
    expect((await discord.patch(bot, path, {})).status).toBe(400);

    res = await discord.patch(bot, `/guilds/${guild.id}/levels`, { level_short_name: 'lv', sources: { voice_minute: { enabled: true } } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ level_short_name: 'lv' });
    expect(res.body.sources.voice_minute.enabled).toBe(true);

    await discord.post(bot, `/channels/${general.id}/messages`, { content: 'beep' });
    expect(await xpOf(guild, bot)).toBe(0);
  });
});
