import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { PERMISSIONS: P, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');

let userCount = 0;
async function makeUser(prefix = 'move-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-move-123';
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
};

// A guild: uncategorised #top, "Text Channels" (#general, #b, #c) and "Other" (#d).
async function setUp() {
  const owner = await makeUser('move-owner');
  let guild = (await api.post(owner, '/guilds', { name: 'Moves' })).body;
  const text = guild.categories[0];
  const other = (await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'Other' })).body;
  const make = async (name, categoryId) => (await api.post(owner, `/guilds/${guild.id}/channels`, { name, categoryId })).body;
  const ch = { general: guild.channels[0], b: await make('b', text.id), c: await make('c', text.id), d: await make('d', other.id), top: await make('top', null) };
  guild = (await api.get(owner, `/guilds/${guild.id}`)).body;
  return { owner, guild, text, other, ch };
}

// The layout as "category: channel, channel" lines, in order.
function shape(layout) {
  const byCategory = (id) => layout.channels.filter((c) => (c.category_id ?? null) === id).map((c) => c.name).join(', ');
  return [`-: ${byCategory(null)}`, ...layout.categories.map((cat) => `${cat.name}: ${byCategory(cat.id)}`)];
}

describe('moving channels and categories', () => {
  it('moves a channel before another, to the end of a category, and out of categories', async () => {
    const { owner, guild, text, other, ch } = await setUp();
    expect(shape(guild)).toEqual(['-: top', 'Text Channels: general, b, c', 'Other: d']);

    let res = await api.put(owner, `/guilds/${guild.id}/channels/${ch.c.id}/move`, { categoryId: text.id, beforeId: ch.general.id });
    expect(res.status).toBe(200);
    expect(shape(res.body)).toEqual(['-: top', 'Text Channels: c, general, b', 'Other: d']);

    res = await api.put(owner, `/guilds/${guild.id}/channels/${ch.general.id}/move`, { categoryId: other.id, beforeId: null });
    expect(shape(res.body)).toEqual(['-: top', 'Text Channels: c, b', 'Other: d, general']);

    res = await api.put(owner, `/guilds/${guild.id}/channels/${ch.d.id}/move`, { categoryId: null, beforeId: ch.top.id });
    expect(shape(res.body)).toEqual(['-: d, top', 'Text Channels: c, b', 'Other: general']);
  });

  it('moves categories', async () => {
    const { owner, guild, text, other } = await setUp();
    let res = await api.put(owner, `/guilds/${guild.id}/categories/${other.id}/move`, { beforeId: text.id });
    expect(res.body.categories.map((c) => c.name)).toEqual(['Other', 'Text Channels']);
    res = await api.put(owner, `/guilds/${guild.id}/categories/${other.id}/move`, { beforeId: null });
    expect(res.body.categories.map((c) => c.name)).toEqual(['Text Channels', 'Other']);
  });

  it('refuses bad targets and people without Manage Channels', async () => {
    const { owner, guild, text, other, ch } = await setUp();
    // beforeId must be in the category given.
    expect((await api.put(owner, `/guilds/${guild.id}/channels/${ch.b.id}/move`, { categoryId: other.id, beforeId: ch.c.id })).status).toBe(400);
    expect((await api.put(owner, `/guilds/${guild.id}/channels/${ch.b.id}/move`, { categoryId: 999999 })).status).toBe(400);
    expect((await api.put(owner, `/guilds/${guild.id}/categories/${text.id}/move`, { beforeId: 999999 })).status).toBe(400);

    const member = await makeUser('move-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(member, `/invites/${invite.body.code}`);
    expect((await api.put(member, `/guilds/${guild.id}/channels/${ch.b.id}/move`, { categoryId: null })).status).toBe(403);
    expect((await api.put(member, `/guilds/${guild.id}/categories/${text.id}/move`, { beforeId: null })).status).toBe(403);
  });

  it("works for a manager who can't see a private channel, which keeps its place", async () => {
    const { owner, guild, text, ch } = await setUp();
    const everyone = guild.roles.find((r) => r.is_everyone);
    await api.put(owner, `/guilds/${guild.id}/channels/${ch.b.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    const manager = await makeUser('move-manager');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(manager, `/invites/${invite.body.code}`);
    await api.patch(owner, `/guilds/${guild.id}/roles/${everyone.id}`, { permissions: DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_CHANNELS });

    const res = await api.put(manager, `/guilds/${guild.id}/channels/${ch.c.id}/move`, { categoryId: text.id, beforeId: ch.general.id });
    expect(res.status).toBe(200);
    expect(shape(res.body)).toEqual(['-: top', 'Text Channels: c, general', 'Other: d']);
    expect(shape((await api.get(owner, `/guilds/${guild.id}`)).body)).toEqual(['-: top', 'Text Channels: c, general, b', 'Other: d']);
    // It can't move what it can't see.
    expect((await api.put(manager, `/guilds/${guild.id}/channels/${ch.b.id}/move`, { categoryId: null })).status).toBe(404);
  });
});
