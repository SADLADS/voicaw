import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { PERMISSIONS: P } = require('../permissions.js');

let userCount = 0;
async function makeUser(prefix = 'clone-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-clone-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};

// A guild with an owner and a member, and its #general.
async function setUp() {
  const owner = await makeUser('clone-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Copies' })).body;
  const bob = await makeUser('clone-member');
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  await api.post(bob, `/invites/${invite.body.code}`);
  return { owner, bob, guild, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

const overridesOf = async (user, guild, channel) => (await api.get(user, `/guilds/${guild.id}/channels/${channel.id}/overrides`)).body
  .map(({ target_type, target_id, allow, deny }) => ({ target_type, target_id, allow, deny }));

describe('cloning a channel', () => {
  it('copies the type, topic, category and permissions, just below the original', async () => {
    const { owner, guild, general, everyone } = await setUp();
    const role = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'crew' })).body;
    const board = (await api.post(owner, `/guilds/${guild.id}/channels`, {
      name: 'tasks', type: 'list', topic: 'To do', categoryId: general.category_id, private: true, roleIds: [role.id],
    })).body;
    await api.put(owner, `/guilds/${guild.id}/channels/${board.id}/overrides/role/${role.id}`, { allow: P.VIEW_CHANNEL, deny: P.EDIT_TASKS });
    const after = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'after', categoryId: general.category_id })).body;

    const res = await api.post(owner, `/guilds/${guild.id}/channels/${board.id}/clone`, { name: 'Tasks Two' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'tasks-two', type: 'list', topic: 'To do', category_id: general.category_id });
    expect(await overridesOf(owner, guild, res.body)).toEqual(await overridesOf(owner, guild, board));
    expect(await overridesOf(owner, guild, res.body)).toContainEqual({ target_type: 'role', target_id: everyone.id, allow: 0, deny: P.VIEW_CHANNEL });

    const layout = (await api.get(owner, `/guilds/${guild.id}`)).body;
    const order = layout.channels.filter((c) => c.category_id === general.category_id).map((c) => c.id);
    expect(order).toEqual([general.id, board.id, res.body.id, after.id]);
    expect(layout.channels.find((c) => c.id === res.body.id).private).toBe(true);

    // Without a name it keeps the original's.
    expect((await api.post(owner, `/guilds/${guild.id}/channels/${general.id}/clone`)).body.name).toBe('general');
    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body.entries;
    expect(log[0]).toMatchObject({ action: 'channel_create', details: { name: 'general', clonedFrom: 'general' } });
  });

  it('needs Manage Channels, and Manage Roles plus the permissions themselves to copy overrides', async () => {
    const { owner, bob, guild, general, everyone } = await setUp();
    expect((await api.post(bob, `/guilds/${guild.id}/channels/${general.id}/clone`)).status).toBe(403);

    const mod = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'mod', permissions: P.MANAGE_CHANNELS })).body;
    await api.put(owner, `/guilds/${guild.id}/members/${bob.id}/roles`, { roleIds: [mod.id] });
    // No overrides: Manage Channels is enough.
    expect((await api.post(bob, `/guilds/${guild.id}/channels/${general.id}/clone`)).status).toBe(201);

    const locked = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'locked' })).body;
    await api.put(owner, `/guilds/${guild.id}/channels/${locked.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.SEND_MESSAGES });
    expect((await api.post(bob, `/guilds/${guild.id}/channels/${locked.id}/clone`)).status).toBe(403);

    // With Manage Roles, but an override sets Manage Messages, which bob doesn't have.
    await request(app).patch(`/api/guilds/${guild.id}/roles/${mod.id}`).set(authed(owner)).send({ permissions: P.MANAGE_CHANNELS | P.MANAGE_ROLES });
    expect((await api.post(bob, `/guilds/${guild.id}/channels/${locked.id}/clone`)).status).toBe(201);
    await api.put(owner, `/guilds/${guild.id}/channels/${locked.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.SEND_MESSAGES | P.MANAGE_MESSAGES });
    expect((await api.post(bob, `/guilds/${guild.id}/channels/${locked.id}/clone`)).status).toBe(403);

    // A channel bob can't see doesn't exist for him.
    const secret = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'secret', private: true })).body;
    expect((await api.post(bob, `/guilds/${guild.id}/channels/${secret.id}/clone`)).status).toBe(404);
    expect((await api.post(owner, `/guilds/${guild.id}/channels/${general.id}/clone`, { name: '   ' })).status).toBe(400);
  });
});
