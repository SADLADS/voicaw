import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

// The caps and per-account limits of guildLimits.js (security audit, low findings L4). Rate
// limits are on for this file only (see setupEnv.js), but for signing up and logging in (read
// once when auth.js loads), as this file makes more accounts than one address may.
const app = require('../index.js');
const db = require('../db');
require('../config').rateLimitsEnabled = true;
const { MAX_CHANNELS_PER_GUILD, MAX_ROLES_PER_GUILD, MAX_LIVE_INVITES_PER_MEMBER, MAX_LIVE_INVITES_PER_GUILD } = require('../guildLimits');
const { MAX_COMMENTS_PER_TASK } = require('../guildTasks');

let count = 0;
async function makeUser() {
  const username = `glimits-${++count}`;
  const { response } = await registerUser(app, request, username, 'pw-glimits-123');
  const login = await loginUser(app, request, username, 'pw-glimits-123');
  return { id: response.body.id, token: login.response.body.token };
}
const authed = (u) => ({ Authorization: `Bearer ${u.token}` });
const post = (u, url, body = {}) => request(app).post(`/api${url}`).set(authed(u)).send(body);
const get = (u, url, query = {}) => request(app).get(`/api${url}`).set(authed(u)).query(query);

async function guildOf(owner) {
  const guild = (await post(owner, '/guilds', { name: 'Limits' })).body;
  return { guild, general: guild.channels.find((c) => c.name === 'general') };
}
async function join(user, guild, owner) {
  const invite = await post(owner, `/guilds/${guild.id}/invites`, { unique: true });
  expect((await post(user, `/invites/${invite.body.code}`)).status).toBeLessThan(300);
}

describe('invites', () => {
  it('gives back your own unused invite with the same settings, unless unique', async () => {
    const owner = await makeUser();
    const { guild } = await guildOf(owner);
    const week = { maxAge: 7 * 24 * 60 * 60, maxUses: 0 };
    const first = (await post(owner, `/guilds/${guild.id}/invites`, week)).body.code;
    expect((await post(owner, `/guilds/${guild.id}/invites`, week)).body.code).toBe(first);
    expect((await post(owner, `/guilds/${guild.id}/invites`, { maxAge: 0, maxUses: 0 })).body.code).not.toBe(first);
    expect((await post(owner, `/guilds/${guild.id}/invites`, { ...week, maxUses: 5 })).body.code).not.toBe(first);
    expect((await post(owner, `/guilds/${guild.id}/invites`, { ...week, unique: true })).body.code).not.toBe(first);

    // Once used, someone asking again gets a new one.
    const friend = await makeUser();
    await post(friend, `/invites/${first}`);
    expect((await post(owner, `/guilds/${guild.id}/invites`, week)).body.code).not.toBe(first);

    // Another member gets their own.
    const other = (await post(friend, `/guilds/${guild.id}/invites`, week)).body.code;
    expect(other).not.toBe(first);
  });

  it('caps live invites per member and per guild', async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const { guild } = await guildOf(owner);
    await join(member, guild, owner);
    const add = (creatorId, n, prefix) => db.transaction(async () => {
      for (let i = 0; i < n; i++) {
        await db.run('INSERT INTO guild_invites (code, guild_id, creator_id) VALUES (?, ?, ?)', [`${prefix}${guild.id}x${i}`, guild.id, creatorId]);
      }
    });
    await add(member.id, MAX_LIVE_INVITES_PER_MEMBER, 'm');
    const full = await post(member, `/guilds/${guild.id}/invites`, { unique: true });
    expect(full.status).toBe(400);
    expect(full.body.error).toMatch(/revoke some/);
    // Expired ones don't count.
    await db.run("UPDATE guild_invites SET expires_at = 1 WHERE code = ?", [`m${guild.id}x0`]);
    expect((await post(member, `/guilds/${guild.id}/invites`, { unique: true })).status).toBe(201);

    // Owner: the invite the member joined with. Fill the rest with a third member's.
    const third = await makeUser();
    await join(third, guild, owner);
    await add(third.id, MAX_LIVE_INVITES_PER_GUILD - MAX_LIVE_INVITES_PER_MEMBER - 2, 't');
    const guildFull = await post(owner, `/guilds/${guild.id}/invites`, { unique: true });
    expect(guildFull.status).toBe(400);
    expect(guildFull.body.error).toMatch(/This guild has/);
  });
});

describe('channels and roles', () => {
  it('stops at 500 channels and categories, threads not counted', async () => {
    const owner = await makeUser();
    const { guild, general } = await guildOf(owner);
    // A new guild has #general and one category: fill up to one short of the cap.
    await db.transaction(async () => {
      for (let i = 0; i < MAX_CHANNELS_PER_GUILD - 3; i++) {
        await db.run("INSERT INTO guild_channels (guild_id, name, type, position) VALUES (?, ?, 'text', ?)", [guild.id, `c${i}`, 10 + i]);
      }
    });
    expect((await post(owner, `/guilds/${guild.id}/channels`, { name: 'last' })).status).toBe(201);
    const full = await post(owner, `/guilds/${guild.id}/channels`, { name: 'one-more' });
    expect(full.status).toBe(400);
    expect(full.body.error).toMatch(/at most 500/);
    expect((await post(owner, `/guilds/${guild.id}/categories`, { name: 'More' })).status).toBe(400);
    expect((await post(owner, `/guilds/${guild.id}/channels/${general.id}/clone`)).status).toBe(400);
    // Threads aren't channels here.
    expect((await post(owner, `/channels/${general.id}/threads`, { name: 'Chat' })).status).toBe(201);
  });

  it('stops at 250 roles, @everyone included', async () => {
    const owner = await makeUser();
    const { guild } = await guildOf(owner);
    await db.transaction(async () => {
      for (let i = 0; i < MAX_ROLES_PER_GUILD - 2; i++) {
        await db.run('INSERT INTO guild_roles (guild_id, name, position, permissions) VALUES (?, ?, ?, 0)', [guild.id, `r${i}`, 1 + i]);
      }
    });
    expect((await post(owner, `/guilds/${guild.id}/roles`, { name: 'last' })).status).toBe(201);
    const full = await post(owner, `/guilds/${guild.id}/roles`, { name: 'one more' });
    expect(full.status).toBe(400);
    expect(full.body.error).toMatch(/at most 250 roles/);
  });

  it('limits how fast someone makes channels, roles and guilds', async () => {
    const owner = await makeUser();
    const { guild } = await guildOf(owner);
    for (let i = 0; i < 60; i++) {
      const path = i % 2 ? `/guilds/${guild.id}/roles` : `/guilds/${guild.id}/channels`;
      expect((await post(owner, path, { name: `n${i}` })).status).toBe(201);
    }
    const blocked = await post(owner, `/guilds/${guild.id}/categories`, { name: 'Too many' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    const maker = await makeUser();
    for (let i = 0; i < 10; i++) expect((await post(maker, '/guilds', { name: `G${i}` })).status).toBe(201);
    expect((await post(maker, '/guilds', { name: 'One more' })).status).toBe(429);
  });
});

describe('messages, threads, search', () => {
  it('limits sending, starting threads and searching per account', async () => {
    const owner = await makeUser();
    const { guild, general } = await guildOf(owner);
    for (let i = 0; i < 60; i++) {
      expect((await post(owner, `/channels/${general.id}/messages`, { content: `hello ${i}` })).status).toBe(201);
    }
    expect((await post(owner, `/channels/${general.id}/messages`, { content: 'too many' })).status).toBe(429);

    for (let i = 0; i < 20; i++) expect((await post(owner, `/channels/${general.id}/threads`, { name: `t${i}` })).status).toBe(201);
    expect((await post(owner, `/channels/${general.id}/threads`, { name: 'too many' })).status).toBe(429);

    for (let i = 0; i < 30; i++) expect((await get(owner, `/guilds/${guild.id}/messages/search`, { content: 'hello' })).status).toBe(200);
    expect((await get(owner, `/guilds/${guild.id}/messages/search`, { content: 'hello' })).status).toBe(429);
  });

  it('limits reactions per account', async () => {
    const owner = await makeUser();
    const { general } = await guildOf(owner);
    const message = (await post(owner, `/channels/${general.id}/messages`, { content: 'react' })).body;
    // Adding the same one again still counts.
    for (let i = 0; i < 120; i++) await post(owner, `/guild-messages/${message.id}/reactions`, { emoji: '👍' });
    expect((await post(owner, `/guild-messages/${message.id}/reactions`, { emoji: '👍' })).status).toBe(429);
  });

  it('limits bots\' autocomplete asked by one person', async () => {
    const owner = await makeUser();
    const { general } = await guildOf(owner);
    for (let i = 0; i < 30; i++) {
      expect((await post(owner, `/channels/${general.id}/autocomplete`, { command_id: 'nope' })).status).not.toBe(429);
    }
    expect((await post(owner, `/channels/${general.id}/autocomplete`, { command_id: 'nope' })).status).toBe(429);
  });
});

describe('lists and documents', () => {
  it('caps comments per task and limits commenting', async () => {
    const owner = await makeUser();
    const { guild } = await guildOf(owner);
    const board = (await post(owner, `/guilds/${guild.id}/channels`, { name: 'todo', type: 'list' })).body;
    const task = (await post(owner, `/channels/${board.id}/tasks`, { title: 'Do it' })).body;
    for (let i = 0; i < 30; i++) expect((await post(owner, `/tasks/${task.id}/comments`, { content: `c${i}` })).status).toBe(201);
    expect((await post(owner, `/tasks/${task.id}/comments`, { content: 'too fast' })).status).toBe(429);

    const other = await makeUser();
    await join(other, guild, owner);
    await db.transaction(async () => {
      for (let i = 30; i < MAX_COMMENTS_PER_TASK; i++) {
        await db.run('INSERT INTO guild_task_comments (task_id, channel_id, sender_id, content, timestamp) VALUES (?, ?, ?, ?, 0)', [task.id, board.id, owner.id, `c${i}`]);
      }
    });
    const full = await post(other, `/tasks/${task.id}/comments`, { content: 'one more' });
    expect(full.status).toBe(400);
    expect(full.body.error).toMatch(/at most 500 comments/);
  });

  it('limits making documents', async () => {
    const owner = await makeUser();
    const { guild } = await guildOf(owner);
    const docs = (await post(owner, `/guilds/${guild.id}/channels`, { name: 'docs', type: 'doc' })).body;
    for (let i = 0; i < 30; i++) {
      const made = await post(owner, `/channels/${docs.id}/documents`, { title: `D${i}`, content: 'Hi' });
      expect(made.status).toBe(201);
      await request(app).delete(`/api/documents/${made.body.id}`).set(authed(owner));
    }
    expect((await post(owner, `/channels/${docs.id}/documents`, { title: 'More', content: 'Hi' })).status).toBe(429);
  });
});
