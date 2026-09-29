import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';
import { signedUploads, deletedObjects } from './helpers/mockS3.js';

const app = require('../index.js');
const { PERMISSIONS: P } = require('../permissions.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'emoji-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-emoji-123';
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

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  Object.defineProperty(events, 'stop', {
    value: () => clients.set(String(user.id), clients.get(String(user.id)).filter((s) => s !== ws)),
  });
  return events;
}

async function guildWith(owner, name, ...members) {
  const guild = (await api.post(owner, '/guilds', { name })).body;
  for (const member of members) {
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(member, `/invites/${invite.body.code}`);
  }
  return guild;
}

// Adds an emoji the whole way (create, "upload", ready).
async function addEmoji(user, guildId, name, type = 'image/png') {
  const created = await api.post(user, `/guilds/${guildId}/emojis`, { name, type, size: 1000 });
  expect(created.status).toBe(201);
  const ready = await api.post(user, `/guilds/${guildId}/emojis/${created.body.emoji.id}/ready`);
  expect(ready.status).toBe(200);
  return ready.body;
}

describe('custom emoji', () => {
  it('adds an emoji in two steps and tells every member', async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const guild = await guildWith(owner, 'Emoji Guild', member);

    const created = await api.post(owner, `/guilds/${guild.id}/emojis`, { name: 'party_blob', type: 'image/gif', size: 5000 });
    expect(created.status).toBe(201);
    expect(created.body.emoji).toMatchObject({ name: 'party_blob', animated: 1, guild_id: guild.id });
    expect(created.body.uploadUrl).toContain('/emojis/');
    expect(signedUploads.at(-1)).toEqual({ filename: String(created.body.emoji.id), bucket: 'emojis', contentType: 'image/gif', contentLength: 5000 });

    // Not offered until the upload is done.
    expect((await api.get(member, '/emojis')).body).toEqual([]);

    const events = listen(member);
    await api.post(owner, `/guilds/${guild.id}/emojis/${created.body.emoji.id}/ready`);
    events.stop();
    const emoji = { id: created.body.emoji.id, guild_id: guild.id, name: 'party_blob', animated: 1 };
    expect(events).toEqual([{ type: 'guild_emojis_update', guildId: guild.id, emojis: [emoji] }]);
    expect((await api.get(member, '/emojis')).body).toEqual([emoji]);
    expect((await api.get(member, `/guilds/${guild.id}/emojis`)).body[0]).toMatchObject({ ...emoji, creator_username: owner.username });
  });

  it('checks names, types, sizes, duplicates and the limit', async () => {
    const owner = await makeUser();
    const guild = await guildWith(owner, 'Rules');
    const create = (body) => api.post(owner, `/guilds/${guild.id}/emojis`, { name: 'ok_name', type: 'image/png', size: 100, ...body });
    expect((await create({ name: 'a' })).status).toBe(400);
    expect((await create({ name: 'has space' })).status).toBe(400);
    expect((await create({ name: 'x'.repeat(33) })).status).toBe(400);
    expect((await create({ type: 'image/svg+xml' })).status).toBe(400);
    expect((await create({ size: 256 * 1024 + 1 })).status).toBe(413);
    await addEmoji(owner, guild.id, 'taken');
    expect((await create({ name: 'taken' })).status).toBe(409);

    for (let i = 1; i < 50; i++) await create({ name: `e${i}` });
    const full = await create({ name: 'one_more' });
    expect(full.status).toBe(400);
    expect(full.body.error).toMatch(/at most 50/);
  });

  it('needs Manage Emoji to add, rename or delete', async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const guild = await guildWith(owner, 'Perms', member);
    const emoji = await addEmoji(owner, guild.id, 'blob');
    expect((await api.post(member, `/guilds/${guild.id}/emojis`, { name: 'mine', type: 'image/png', size: 10 })).status).toBe(403);
    expect((await api.patch(member, `/guilds/${guild.id}/emojis/${emoji.id}`, { name: 'renamed' })).status).toBe(403);
    expect((await api.delete(member, `/guilds/${guild.id}/emojis/${emoji.id}`)).status).toBe(403);

    const everyone = guild.roles.find((r) => r.is_everyone);
    const role = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Emoji', permissions: P.MANAGE_EMOJIS })).body;
    await api.put(owner, `/guilds/${guild.id}/members/${member.id}/roles`, { roleIds: [role.id] });
    expect(everyone).toBeTruthy();
    expect((await api.patch(member, `/guilds/${guild.id}/emojis/${emoji.id}`, { name: 'renamed' })).body.name).toBe('renamed');
    await addEmoji(member, guild.id, 'members_own');
  });

  it('renames and deletes, removing the image', async () => {
    const owner = await makeUser();
    const guild = await guildWith(owner, 'Edits');
    const a = await addEmoji(owner, guild.id, 'first');
    const b = await addEmoji(owner, guild.id, 'second');
    expect((await api.patch(owner, `/guilds/${guild.id}/emojis/${a.id}`, { name: 'second' })).status).toBe(409);
    expect((await api.patch(owner, `/guilds/${guild.id}/emojis/${a.id}`, { name: 'bad name' })).status).toBe(400);

    expect((await api.delete(owner, `/guilds/${guild.id}/emojis/${b.id}`)).status).toBe(200);
    expect(deletedObjects).toContainEqual({ bucket: 'emojis', key: String(b.id) });
    expect((await api.get(owner, '/emojis')).body.map((e) => e.name)).toEqual(['first']);

    // Another guild's emoji isn't reachable through this one.
    const other = await guildWith(owner, 'Other');
    expect((await api.delete(owner, `/guilds/${other.id}/emojis/${a.id}`)).status).toBe(404);

    // Deleting the guild deletes its emoji.
    await api.delete(owner, `/guilds/${guild.id}`);
    expect(deletedObjects).toContainEqual({ bucket: 'emojis', key: String(a.id) });
    expect((await api.get(owner, '/emojis')).body).toEqual([]);
  });

  it("offers only your guilds' emoji, in your rail order", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const one = await guildWith(alice, 'One');
    const two = await guildWith(alice, 'Two');
    await addEmoji(alice, one.id, 'from_one');
    await addEmoji(alice, two.id, 'from_two');
    expect((await api.get(alice, '/emojis')).body.map((e) => e.name)).toEqual(['from_one', 'from_two']);
    expect((await api.get(bob, '/emojis')).body).toEqual([]);

    await api.put(alice, '/guilds-order', { guildIds: [two.id, one.id] });
    expect((await api.get(alice, '/emojis')).body.map((e) => e.name)).toEqual(['from_two', 'from_one']);
  });
});

describe('server rail order', () => {
  it('lists guilds in your own order, new ones at the bottom', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const a = await guildWith(alice, 'A', bob);
    const b = await guildWith(alice, 'B', bob);
    const c = await guildWith(bob, 'C');
    expect((await api.get(bob, '/guilds')).body.map((g) => g.name)).toEqual(['A', 'B', 'C']);

    const events = listen(bob);
    expect((await api.put(bob, '/guilds-order', { guildIds: [c.id, a.id, b.id] })).status).toBe(200);
    events.stop();
    expect(events).toEqual([{ type: 'guild_order', guildIds: [c.id, a.id, b.id] }]);
    expect((await api.get(bob, '/guilds')).body.map((g) => g.name)).toEqual(['C', 'A', 'B']);
    // Alice's order is her own.
    expect((await api.get(alice, '/guilds')).body.map((g) => g.name)).toEqual(['A', 'B']);

    const d = await guildWith(bob, 'D');
    expect((await api.get(bob, '/guilds')).body.map((g) => g.name)).toEqual(['C', 'A', 'B', 'D']);
    expect(d.id).toBeTruthy();
  });

  it('must list each of your guilds exactly once', async () => {
    const alice = await makeUser();
    const a = await guildWith(alice, 'A');
    const b = await guildWith(alice, 'B');
    const stranger = await guildWith(await makeUser(), 'Not hers');
    expect((await api.put(alice, '/guilds-order', { guildIds: [a.id] })).status).toBe(400);
    expect((await api.put(alice, '/guilds-order', { guildIds: [a.id, a.id] })).status).toBe(400);
    expect((await api.put(alice, '/guilds-order', { guildIds: [a.id, stranger.id] })).status).toBe(400);
    expect((await api.put(alice, '/guilds-order', { guildIds: [b.id, a.id] })).status).toBe(200);
  });
});
