import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { PERMISSIONS: P, ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'role-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-roles-123';
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

// A guild with an owner and `count` other members, and its #general.
async function setUp(count = 2) {
  const owner = await makeUser('owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Roles Guild' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  return { owner, members, guild, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

async function createRole(actor, guildId, body = {}) {
  const res = await api.post(actor, `/guilds/${guildId}/roles`, body);
  expect(res.status).toBe(201);
  return res.body;
}

const giveRoles = (actor, guildId, user, roleIds) => api.put(actor, `/guilds/${guildId}/members/${user.id}/roles`, { roleIds });
const layout = async (user, guildId) => (await api.get(user, `/guilds/${guildId}`)).body;

describe('roles', () => {
  it('starts every guild with @everyone and the default permissions', async () => {
    const { owner, members, guild } = await setUp(1);
    expect(guild.roles).toEqual([
      { id: expect.any(Number), name: '@everyone', color: null, position: 0, permissions: DEFAULT_EVERYONE_PERMISSIONS, hoist: 0, mentionable: 0, is_everyone: 1, bot_id: null },
    ]);
    expect(guild.my_permissions).toBe(ALL_PERMISSIONS);
    expect((await layout(members[0], guild.id)).my_permissions).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    expect(guild.channels[0]).toMatchObject({ my_permissions: ALL_PERMISSIONS, private: false });
    expect((await api.post(members[0], `/guilds/${guild.id}/roles`)).status).toBe(403);
    expect((await api.get(owner, `/guilds/${guild.id}/members`)).body.every((m) => Array.isArray(m.role_ids))).toBe(true);
  });

  it('creates roles at the bottom, edits and reorders them', async () => {
    const { owner, guild } = await setUp(0);
    const first = await createRole(owner, guild.id, { name: 'Mods', color: 0xe91e63, hoist: true, permissions: P.KICK_MEMBERS });
    expect(first).toMatchObject({ name: 'Mods', color: 0xe91e63, hoist: 1, position: 1, permissions: P.KICK_MEMBERS });
    const second = await createRole(owner, guild.id);
    expect(second).toMatchObject({ name: 'new role', position: 1, color: null });

    let roles = (await layout(owner, guild.id)).roles;
    expect(roles.map((r) => r.name)).toEqual(['Mods', 'new role', '@everyone']);

    expect((await api.put(owner, `/guilds/${guild.id}/roles/order`, { roleIds: [second.id, first.id] })).status).toBe(200);
    roles = (await layout(owner, guild.id)).roles;
    expect(roles.map((r) => [r.name, r.position])).toEqual([['new role', 2], ['Mods', 1], ['@everyone', 0]]);

    const edited = await api.patch(owner, `/guilds/${guild.id}/roles/${second.id}`, { name: 'Helpers', color: null });
    expect(edited.body).toMatchObject({ name: 'Helpers', color: null });
    expect((await api.patch(owner, `/guilds/${guild.id}/roles/${second.id}`, { color: 0x1000000 })).status).toBe(400);
    expect((await api.patch(owner, `/guilds/${guild.id}/roles/${second.id}`, { permissions: 2 ** 31 })).status).toBe(400);
    expect((await api.put(owner, `/guilds/${guild.id}/roles/order`, { roleIds: [first.id] })).status).toBe(400);
  });

  it("keeps @everyone's name and place, but lets its permissions change", async () => {
    const { owner, members, guild, everyone } = await setUp(1);
    expect((await api.patch(owner, `/guilds/${guild.id}/roles/${everyone.id}`, { name: 'all' })).status).toBe(400);
    expect((await api.delete(owner, `/guilds/${guild.id}/roles/${everyone.id}`)).status).toBe(400);

    // Taking Create Invite away from everyone.
    const res = await api.patch(owner, `/guilds/${guild.id}/roles/${everyone.id}`, { permissions: P.VIEW_CHANNEL | P.SEND_MESSAGES });
    expect(res.status).toBe(200);
    expect((await api.post(members[0], `/guilds/${guild.id}/invites`)).status).toBe(403);
  });

  it('gives members roles, and their permissions follow', async () => {
    const { owner, members: [alice, bob], guild } = await setUp(2);
    const builders = await createRole(owner, guild.id, { name: 'Builders', permissions: P.MANAGE_CHANNELS });
    expect((await api.post(alice, `/guilds/${guild.id}/channels`, { name: 'nope' })).status).toBe(403);

    const bobEvents = listen(bob);
    const res = await giveRoles(owner, guild.id, alice, [builders.id]);
    bobEvents.stop();
    expect(res.status).toBe(200);
    expect(bobEvents).toContainEqual({ type: 'guild_member_update', guildId: guild.id, userId: alice.id, roleIds: [builders.id] });
    expect((await layout(alice, guild.id)).my_role_ids).toEqual([builders.id]);

    expect((await api.post(alice, `/guilds/${guild.id}/channels`, { name: 'built' })).status).toBe(201);
    const members = (await api.get(bob, `/guilds/${guild.id}/members`)).body;
    expect(members.find((m) => m.id === alice.id).role_ids).toEqual([builders.id]);

    // Deleting the role takes it away again.
    expect((await api.delete(owner, `/guilds/${guild.id}/roles/${builders.id}`)).status).toBe(200);
    expect((await api.post(alice, `/guilds/${guild.id}/channels`, { name: 'again' })).status).toBe(403);
    expect((await api.get(bob, `/guilds/${guild.id}/members`)).body.find((m) => m.id === alice.id).role_ids).toEqual([]);
  });

  it('only reaches below your own highest role', async () => {
    const { owner, members: [alice, bob, carol], guild } = await setUp(3);
    const admins = await createRole(owner, guild.id, { name: 'Admins', permissions: P.MANAGE_ROLES | P.KICK_MEMBERS });
    const mods = await createRole(owner, guild.id, { name: 'Mods', permissions: P.KICK_MEMBERS });
    const regulars = await createRole(owner, guild.id, { name: 'Regulars' });
    // Top to bottom: Admins, Mods, Regulars.
    await api.put(owner, `/guilds/${guild.id}/roles/order`, { roleIds: [admins.id, mods.id, regulars.id] });
    await giveRoles(owner, guild.id, alice, [admins.id]);
    await giveRoles(owner, guild.id, bob, [admins.id]);

    // Alice can hand out roles below Admins, but not Admins itself, and not to an equal.
    expect((await giveRoles(alice, guild.id, carol, [mods.id])).status).toBe(200);
    expect((await giveRoles(alice, guild.id, carol, [mods.id, admins.id])).status).toBe(403);
    expect((await giveRoles(alice, guild.id, bob, [])).status).toBe(403);
    expect((await giveRoles(alice, guild.id, owner, [regulars.id])).status).toBe(403);

    // Edit roles below, not her own or above; can't give permissions she lacks.
    expect((await api.patch(alice, `/guilds/${guild.id}/roles/${mods.id}`, { name: 'Moderators' })).status).toBe(200);
    expect((await api.patch(alice, `/guilds/${guild.id}/roles/${admins.id}`, { name: 'Gods' })).status).toBe(403);
    expect((await api.patch(alice, `/guilds/${guild.id}/roles/${mods.id}`, { permissions: P.BAN_MEMBERS })).status).toBe(403);
    expect((await api.post(alice, `/guilds/${guild.id}/roles`, { permissions: P.ADMINISTRATOR })).status).toBe(403);

    // Reorder below herself only.
    expect((await api.put(alice, `/guilds/${guild.id}/roles/order`, { roleIds: [admins.id, regulars.id, mods.id] })).status).toBe(200);
    expect((await api.put(alice, `/guilds/${guild.id}/roles/order`, { roleIds: [mods.id, admins.id, regulars.id] })).status).toBe(403);

    // Kick: carol (Mods, now below) yes; bob (equal) and the owner no.
    expect((await api.delete(alice, `/guilds/${guild.id}/members/${bob.id}`)).status).toBe(403);
    expect((await api.delete(alice, `/guilds/${guild.id}/members/${owner.id}`)).status).toBe(403);
    expect((await api.delete(alice, `/guilds/${guild.id}/members/${carol.id}`)).status).toBe(200);
  });

  it('lets Manage Messages delete anyone\'s messages', async () => {
    const { owner, members: [alice, bob], guild, general } = await setUp(2);
    const msg = (await api.post(bob, `/channels/${general.id}/messages`, { content: 'spam' })).body;
    expect((await api.delete(alice, `/guild-messages/${msg.id}`)).status).toBe(403);
    const mods = await createRole(owner, guild.id, { name: 'Mods', permissions: P.MANAGE_MESSAGES });
    await giveRoles(owner, guild.id, alice, [mods.id]);
    expect((await api.delete(alice, `/guild-messages/${msg.id}`)).status).toBe(200);
  });
});

describe('private channels and overrides', () => {
  it('hides a private channel from everyone but its roles', async () => {
    const { owner, members: [alice, bob], guild } = await setUp(2);
    const staff = await createRole(owner, guild.id, { name: 'Staff' });
    await giveRoles(owner, guild.id, alice, [staff.id]);

    const created = await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'staff-room', private: true, roleIds: [staff.id] });
    expect(created.status).toBe(201);
    const channel = created.body;

    const aliceLayout = await layout(alice, guild.id);
    expect(aliceLayout.channels.find((c) => c.id === channel.id)).toMatchObject({ private: true });
    expect((await layout(bob, guild.id)).channels.some((c) => c.id === channel.id)).toBe(false);
    expect((await layout(owner, guild.id)).channels.some((c) => c.id === channel.id)).toBe(true);

    // Bob can't read, post, or hear about it; alice can.
    expect((await api.get(bob, `/channels/${channel.id}/messages`)).status).toBe(404);
    expect((await api.post(bob, `/channels/${channel.id}/messages`, { content: 'let me in' })).status).toBe(404);
    const bobEvents = listen(bob);
    const aliceEvents = listen(alice);
    const secret = await api.post(owner, `/channels/${channel.id}/messages`, { content: 'secret plans' });
    bobEvents.stop();
    aliceEvents.stop();
    expect(bobEvents).toEqual([]);
    expect(aliceEvents.map((e) => e.type)).toEqual(['guild_message_new']);
    expect((await api.get(alice, `/channels/${channel.id}/messages`)).body.map((m) => m.content)).toEqual(['secret plans']);
    expect((await api.delete(bob, `/guild-messages/${secret.body.id}`)).status).toBe(404);

    // Unread counts only cover channels you can see.
    expect((await api.get(bob, '/guild-unread')).body).toEqual([]);
    expect((await api.get(alice, '/guild-unread')).body).toEqual([{ channel_id: channel.id, guild_id: guild.id, count: 1, mentions: 0 }]);

    // Taking the role away hides it again, and alice is told.
    const events = listen(alice);
    await giveRoles(owner, guild.id, alice, []);
    events.stop();
    const update = events.find((e) => e.type === 'guild_update');
    expect(update.guild.channels.some((c) => c.id === channel.id)).toBe(false);
  });

  it('needs Manage Roles to make a channel private', async () => {
    const { owner, members: [alice], guild } = await setUp(1);
    const builders = await createRole(owner, guild.id, { name: 'Builders', permissions: P.MANAGE_CHANNELS });
    await giveRoles(owner, guild.id, alice, [builders.id]);
    expect((await api.post(alice, `/guilds/${guild.id}/channels`, { name: 'hidden', private: true })).status).toBe(403);

    // With it, the creator can still see the channel they made.
    await api.patch(owner, `/guilds/${guild.id}/roles/${builders.id}`, { permissions: P.MANAGE_CHANNELS | P.MANAGE_ROLES });
    const created = await api.post(alice, `/guilds/${guild.id}/channels`, { name: 'hidden', private: true });
    expect(created.status).toBe(201);
    expect((await layout(alice, guild.id)).channels.some((c) => c.id === created.body.id)).toBe(true);
  });

  it('sets channel overrides for roles and members', async () => {
    const { owner, members: [alice, bob], guild, general, everyone } = await setUp(2);
    const base = `/guilds/${guild.id}/channels/${general.id}/overrides`;

    // An announcements-style channel: nobody posts but alice.
    expect((await api.put(owner, `${base}/role/${everyone.id}`, { deny: P.SEND_MESSAGES })).status).toBe(200);
    expect((await api.put(owner, `${base}/member/${alice.id}`, { allow: P.SEND_MESSAGES })).status).toBe(200);
    expect((await api.post(bob, `/channels/${general.id}/messages`, { content: 'hi' })).status).toBe(403);
    expect((await api.post(alice, `/channels/${general.id}/messages`, { content: 'news' })).status).toBe(201);
    expect((await layout(bob, guild.id)).channels[0].my_permissions & P.SEND_MESSAGES).toBe(0);

    expect((await api.get(owner, base)).body).toEqual([
      { target_type: 'role', target_id: everyone.id, allow: 0, deny: P.SEND_MESSAGES },
      { target_type: 'member', target_id: alice.id, allow: P.SEND_MESSAGES, deny: 0 },
    ]);

    // Only channel permissions, never both allowed and denied, real targets, managers only.
    expect((await api.put(owner, `${base}/role/${everyone.id}`, { deny: P.KICK_MEMBERS })).status).toBe(400);
    expect((await api.put(owner, `${base}/role/${everyone.id}`, { allow: P.SEND_MESSAGES, deny: P.SEND_MESSAGES })).status).toBe(400);
    expect((await api.put(owner, `${base}/role/99999`, { deny: P.SEND_MESSAGES })).status).toBe(404);
    expect((await api.put(owner, `${base}/nobody/1`, { deny: P.SEND_MESSAGES })).status).toBe(400);
    expect((await api.put(bob, `${base}/role/${everyone.id}`, {})).status).toBe(403);
    expect((await api.get(bob, base)).status).toBe(403);

    // Clearing an override removes it.
    await api.put(owner, `${base}/role/${everyone.id}`, { allow: 0, deny: 0 });
    expect((await api.post(bob, `/channels/${general.id}/messages`, { content: 'free again' })).status).toBe(201);
    expect((await api.get(owner, base)).body).toHaveLength(1);
  });

  it('removes a kicked member\'s roles and overrides', async () => {
    const { owner, members: [alice], guild, general } = await setUp(1);
    const role = await createRole(owner, guild.id, { name: 'Temp' });
    await giveRoles(owner, guild.id, alice, [role.id]);
    await api.put(owner, `/guilds/${guild.id}/channels/${general.id}/overrides/member/${alice.id}`, { deny: P.ADD_REACTIONS });
    await api.delete(owner, `/guilds/${guild.id}/members/${alice.id}`);

    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(alice, `/invites/${invite.body.code}`);
    const me = (await api.get(owner, `/guilds/${guild.id}/members`)).body.find((m) => m.id === alice.id);
    expect(me.role_ids).toEqual([]);
    expect((await api.get(owner, `/guilds/${guild.id}/channels/${general.id}/overrides`)).body).toEqual([]);
  });
});
