import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

// Category permissions (categoryOverrides.js, docs/guilds.md): Discord's copy-and-sync model.
const app = require('../index.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { toDiscordPermissions, CATEGORY_ID_BASE } = require('../discord.js');

let userCount = 0;
async function makeUser(prefix = 'cat-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-category-123';
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
  put: (bot, url, body) => request(app).put(`/api/v10${url}`).set(botAuth(bot)).send(body),
  patch: (bot, url, body = {}) => request(app).patch(`/api/v10${url}`).set(botAuth(bot)).send(body),
  delete: (bot, url) => request(app).delete(`/api/v10${url}`).set(botAuth(bot)),
};

// A guild with an owner, `count` members, its "Text Channels" category and #general in it.
async function setUp(count = 2) {
  const owner = await makeUser('cat-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Categories' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('cat-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  return {
    owner, members, guild,
    category: guild.categories[0],
    general: guild.channels[0],
    everyone: guild.roles.find((r) => r.is_everyone),
  };
}

const layout = async (user, guildId) => (await api.get(user, `/guilds/${guildId}`)).body;
const channelOverrides = async (owner, guildId, channelId) => (await api.get(owner, `/guilds/${guildId}/channels/${channelId}/overrides`)).body;
const categoryOverrides = async (owner, guildId, categoryId) => (await api.get(owner, `/guilds/${guildId}/categories/${categoryId}/overrides`)).body;
const setCategory = (actor, guildId, categoryId, type, id, bits) => api.put(actor, `/guilds/${guildId}/categories/${categoryId}/overrides/${type}/${id}`, bits);
const setChannel = (actor, guildId, channelId, type, id, bits) => api.put(actor, `/guilds/${guildId}/channels/${channelId}/overrides/${type}/${id}`, bits);
async function makeChannel(owner, guildId, body) {
  const res = await api.post(owner, `/guilds/${guildId}/channels`, body);
  expect(res.status).toBe(201);
  return res.body;
}

describe('category overrides', () => {
  it('reach synced channels and leave changed ones alone', async () => {
    const { owner, members, guild, category, general, everyone } = await setUp(1);
    const other = await makeChannel(owner, guild.id, { name: 'other', categoryId: category.id });
    // #other is changed by hand: no longer synced.
    await setChannel(owner, guild.id, other.id, 'role', everyone.id, { allow: 0, deny: P.ADD_REACTIONS });
    expect((await layout(owner, guild.id)).channels.map((c) => [c.name, c.permissions_synced])).toEqual([['general', true], ['other', false]]);

    const res = await setCategory(owner, guild.id, category.id, 'role', everyone.id, { allow: 0, deny: P.SEND_MESSAGES });
    expect(res.status).toBe(200);
    expect(res.body.synced_channels).toBe(1);
    expect(await categoryOverrides(owner, guild.id, category.id)).toEqual([{ target_type: 'role', target_id: everyone.id, allow: 0, deny: P.SEND_MESSAGES }]);
    expect(await channelOverrides(owner, guild.id, general.id)).toEqual([{ target_type: 'role', target_id: everyone.id, allow: 0, deny: P.SEND_MESSAGES }]);
    expect(await channelOverrides(owner, guild.id, other.id)).toEqual([{ target_type: 'role', target_id: everyone.id, allow: 0, deny: P.ADD_REACTIONS }]);
    // It counts in #general for members, and the layout says so.
    const seen = await layout(members[0], guild.id);
    expect(seen.channels.find((c) => c.id === general.id).my_permissions & P.SEND_MESSAGES).toBe(0);
    expect(seen.categories[0]).toMatchObject({ id: category.id, private: false });
    expect(seen.categories[0].my_permissions & P.SEND_MESSAGES).toBe(0);

    // Taking it away again follows too; the audit log has both, with the channels that followed.
    await setCategory(owner, guild.id, category.id, 'role', everyone.id, { allow: 0, deny: 0 });
    expect(await channelOverrides(owner, guild.id, general.id)).toEqual([]);
    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body;
    const entries = (log.entries ?? log).filter((e) => e.action === 'category_override_update');
    expect(entries).toHaveLength(2);
    expect(entries[0].details).toMatchObject({ categoryName: category.name, targetName: '@everyone', syncedChannels: ['general'] });
  });

  it('follow the same rules as channel overrides', async () => {
    const { owner, members, guild, category, everyone } = await setUp(2);
    const [mod, plain] = members;
    const mods = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Mods', permissions: P.MANAGE_ROLES | P.VIEW_CHANNEL })).body;
    await api.put(owner, `/guilds/${guild.id}/members/${mod.id}/roles`, { roleIds: [mods.id] });
    // Nobody without Manage Roles.
    expect((await api.get(plain, `/guilds/${guild.id}/categories/${category.id}/overrides`)).status).toBe(403);
    expect((await setCategory(plain, guild.id, category.id, 'role', everyone.id, { deny: P.SEND_MESSAGES })).status).toBe(403);
    // Not their own role (as high as theirs), not bits they don't have, not nonsense.
    expect((await setCategory(mod, guild.id, category.id, 'role', mods.id, { deny: P.VIEW_CHANNEL })).status).toBe(403);
    expect((await setCategory(mod, guild.id, category.id, 'role', everyone.id, { deny: P.MANAGE_MESSAGES })).status).toBe(403);
    expect((await setCategory(mod, guild.id, category.id, 'role', everyone.id, { allow: P.SEND_MESSAGES, deny: P.SEND_MESSAGES })).status).toBe(400);
    expect((await setCategory(mod, guild.id, category.id, 'role', everyone.id, { deny: P.KICK_MEMBERS })).status).toBe(400);
    expect((await setCategory(owner, guild.id, 999999, 'role', everyone.id, { deny: P.VIEW_CHANNEL })).status).toBe(404);
    // What they do have works.
    expect((await setCategory(mod, guild.id, category.id, 'role', everyone.id, { deny: P.VIEW_CHANNEL })).status).toBe(200);
  });

  it('start new channels with them, and make private categories', async () => {
    const { owner, members, guild, everyone } = await setUp(1);
    const created = await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'Staff', private: true });
    expect(created.status).toBe(201);
    const staff = created.body;
    // Owners see everything anyway, so only @everyone's deny.
    expect(await categoryOverrides(owner, guild.id, staff.id)).toEqual([{ target_type: 'role', target_id: everyone.id, allow: 0, deny: P.VIEW_CHANNEL }]);
    // A new channel in it starts private; a private one adds its own on top.
    const plans = await makeChannel(owner, guild.id, { name: 'plans', categoryId: staff.id });
    expect(await channelOverrides(owner, guild.id, plans.id)).toEqual(await categoryOverrides(owner, guild.id, staff.id));
    const role = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Helpers' })).body;
    const secret = await makeChannel(owner, guild.id, { name: 'secret', categoryId: staff.id, private: true, roleIds: [role.id] });
    expect(await channelOverrides(owner, guild.id, secret.id)).toEqual(expect.arrayContaining([
      { target_type: 'role', target_id: everyone.id, allow: 0, deny: P.VIEW_CHANNEL },
      { target_type: 'role', target_id: role.id, allow: P.VIEW_CHANNEL, deny: 0 },
    ]));
    // The member sees neither the channels nor the category.
    const seen = await layout(members[0], guild.id);
    expect(seen.categories.map((c) => c.name)).not.toContain('Staff');
    expect(seen.channels.map((c) => c.name)).not.toContain('plans');
    expect((await layout(owner, guild.id)).categories.find((c) => c.id === staff.id)).toMatchObject({ private: true });
    // Without Manage Roles a category can't be made private.
    const managers = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Channels', permissions: P.MANAGE_CHANNELS | P.VIEW_CHANNEL })).body;
    await api.put(owner, `/guilds/${guild.id}/members/${members[0].id}/roles`, { roleIds: [managers.id] });
    expect((await api.post(members[0], `/guilds/${guild.id}/categories`, { name: 'Mine', private: true })).status).toBe(403);
    // But a channel can be made in a private category by someone who sees it (as in Discord).
    await setCategory(owner, guild.id, staff.id, 'role', managers.id, { allow: P.VIEW_CHANNEL });
    const theirs = await api.post(members[0], `/guilds/${guild.id}/channels`, { name: 'theirs', categoryId: staff.id });
    expect(theirs.status).toBe(201);
    expect((await layout(members[0], guild.id)).channels.map((c) => c.name)).toContain('theirs');
  });

  it('show an empty category only to those who can view it', async () => {
    const { owner, members, guild, everyone } = await setUp(1);
    const empty = (await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'Empty' })).body;
    expect((await layout(members[0], guild.id)).categories.map((c) => c.id)).toContain(empty.id);
    await setCategory(owner, guild.id, empty.id, 'role', everyone.id, { deny: P.VIEW_CHANNEL });
    expect((await layout(members[0], guild.id)).categories.map((c) => c.id)).not.toContain(empty.id);
    // A channel they can see in it shows it again.
    const open = await makeChannel(owner, guild.id, { name: 'open', categoryId: empty.id });
    await setChannel(owner, guild.id, open.id, 'role', everyone.id, { allow: 0, deny: 0 });
    expect((await layout(members[0], guild.id)).categories.map((c) => c.id)).toContain(empty.id);
  });
});

describe('moving channels between categories', () => {
  it('a synced channel takes the new category\'s overrides; a changed one keeps its own', async () => {
    const { owner, guild, category, general, everyone } = await setUp(0);
    const staff = (await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'Staff', private: true })).body;
    // #general is synced with Text Channels (both have none): it goes private with Staff.
    const moved = await api.put(owner, `/guilds/${guild.id}/channels/${general.id}/move`, { categoryId: staff.id });
    expect(moved.status).toBe(200);
    expect(await channelOverrides(owner, guild.id, general.id)).toEqual([{ target_type: 'role', target_id: everyone.id, allow: 0, deny: P.VIEW_CHANNEL }]);
    expect(moved.body.channels.find((c) => c.id === general.id)).toMatchObject({ private: true, permissions_synced: true });

    // A changed channel keeps its own when moved.
    const own = await makeChannel(owner, guild.id, { name: 'own', categoryId: category.id });
    await setChannel(owner, guild.id, own.id, 'role', everyone.id, { deny: P.ADD_REACTIONS });
    await api.patch(owner, `/guilds/${guild.id}/channels/${own.id}`, { categoryId: staff.id });
    expect(await channelOverrides(owner, guild.id, own.id)).toEqual([{ target_type: 'role', target_id: everyone.id, allow: 0, deny: P.ADD_REACTIONS }]);
    expect((await layout(owner, guild.id)).channels.find((c) => c.id === own.id).permissions_synced).toBe(false);

    // An uncategorised channel with no overrides counts as synced (/layout).
    const loose = await makeChannel(owner, guild.id, { name: 'loose' });
    const now = await layout(owner, guild.id);
    const order = now.channels.map((c) => ({ id: c.id, categoryId: c.id === loose.id ? staff.id : c.category_id }));
    expect((await api.put(owner, `/guilds/${guild.id}/layout`, { categories: now.categories.map((c) => c.id), channels: order })).status).toBe(200);
    expect(await channelOverrides(owner, guild.id, loose.id)).toEqual(await categoryOverrides(owner, guild.id, staff.id));

    // Moving out of every category keeps them.
    await api.put(owner, `/guilds/${guild.id}/channels/${loose.id}/move`, { categoryId: null });
    expect(await channelOverrides(owner, guild.id, loose.id)).toHaveLength(1);
  });

  it('keeps a channel\'s overrides when the mover may not change them', async () => {
    const { owner, members, guild, general, everyone } = await setUp(1);
    const [mover] = members;
    const movers = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Movers', permissions: P.MANAGE_CHANNELS | P.VIEW_CHANNEL })).body;
    await api.put(owner, `/guilds/${guild.id}/members/${mover.id}/roles`, { roleIds: [movers.id] });
    const quiet = (await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'Quiet' })).body;
    await setCategory(owner, guild.id, quiet.id, 'role', everyone.id, { deny: P.SEND_MESSAGES });
    // No Manage Roles: the move happens, the overrides stay (not synced any more).
    expect((await api.put(mover, `/guilds/${guild.id}/channels/${general.id}/move`, { categoryId: quiet.id })).status).toBe(200);
    expect(await channelOverrides(owner, guild.id, general.id)).toEqual([]);
    const seen = (await layout(owner, guild.id)).channels.find((c) => c.id === general.id);
    expect(seen).toMatchObject({ category_id: quiet.id, permissions_synced: false });
  });

  it('Sync now makes a channel its category\'s again', async () => {
    const { owner, members, guild, category, general, everyone } = await setUp(1);
    await setCategory(owner, guild.id, category.id, 'role', everyone.id, { deny: P.ADD_REACTIONS });
    await setChannel(owner, guild.id, general.id, 'role', everyone.id, { deny: P.SEND_MESSAGES });
    expect((await layout(owner, guild.id)).channels[0].permissions_synced).toBe(false);
    expect((await api.put(members[0], `/guilds/${guild.id}/channels/${general.id}/sync`)).status).toBe(403);
    expect((await api.put(owner, `/guilds/${guild.id}/channels/${general.id}/sync`)).status).toBe(200);
    expect(await channelOverrides(owner, guild.id, general.id)).toEqual([{ target_type: 'role', target_id: everyone.id, allow: 0, deny: P.ADD_REACTIONS }]);
    expect((await layout(owner, guild.id)).channels[0].permissions_synced).toBe(true);
    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body;
    expect((log.entries ?? log).some((e) => e.action === 'channel_permissions_sync')).toBe(true);
    // Not for a channel outside every category.
    const loose = await makeChannel(owner, guild.id, { name: 'loose' });
    expect((await api.put(owner, `/guilds/${guild.id}/channels/${loose.id}/sync`)).status).toBe(400);
  });

  it('deleting a category keeps its channels\' overrides', async () => {
    const { owner, guild, category, general, everyone } = await setUp(0);
    await setCategory(owner, guild.id, category.id, 'role', everyone.id, { deny: P.SEND_MESSAGES });
    expect((await api.delete(owner, `/guilds/${guild.id}/categories/${category.id}`)).status).toBe(200);
    expect(await channelOverrides(owner, guild.id, general.id)).toEqual([{ target_type: 'role', target_id: everyone.id, allow: 0, deny: P.SEND_MESSAGES }]);
    expect((await layout(owner, guild.id)).channels[0]).toMatchObject({ category_id: null, permissions_synced: false });
  });
});

describe('the bot API', () => {
  it('shows, sets and deletes a category\'s overwrites, and lock_permissions', async () => {
    const { owner, guild, category, general } = await setUp(0);
    const app_ = (await api.post(owner, '/applications', { name: 'Category Bot' })).body;
    const bot = { id: app_.id, token: app_.token };
    const perms = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.MANAGE_ROLES | P.MANAGE_CHANNELS;
    expect((await api.post(owner, '/oauth2/authorize', { client_id: String(bot.id), guild_id: guild.id, permissions: toDiscordPermissions(perms) })).status).toBe(201);
    const categoryId = String(CATEGORY_ID_BASE + category.id);
    // A role below the bot's (made after it joined), denied Send Messages in the category.
    const fans = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Fans' })).body;

    const put = await discord.put(bot, `/channels/${categoryId}/permissions/${fans.id}`, { type: 0, allow: '0', deny: toDiscordPermissions(P.SEND_MESSAGES) });
    expect(put.status).toBe(204);
    const overwrite = { id: String(fans.id), type: 0, allow: '0', deny: toDiscordPermissions(P.SEND_MESSAGES) };
    expect((await discord.get(bot, `/channels/${categoryId}`)).body.permission_overwrites).toEqual([overwrite]);
    const listed = (await discord.get(bot, `/guilds/${guild.id}/channels`)).body;
    expect(listed.find((c) => c.id === categoryId).permission_overwrites).toEqual([overwrite]);
    // #general followed.
    expect(listed.find((c) => c.id === String(general.id)).permission_overwrites).toEqual([overwrite]);

    // lock_permissions false keeps a channel's own; true makes it the category's.
    const other = (await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'Other' })).body;
    expect((await discord.patch(bot, `/channels/${general.id}`, { parent_id: String(CATEGORY_ID_BASE + other.id), lock_permissions: false })).status).toBe(200);
    expect(await channelOverrides(owner, guild.id, general.id)).toHaveLength(1);
    expect((await discord.patch(bot, `/channels/${general.id}`, { lock_permissions: true })).status).toBe(200);
    expect(await channelOverrides(owner, guild.id, general.id)).toEqual([]);

    expect((await discord.delete(bot, `/channels/${categoryId}/permissions/${fans.id}`)).status).toBe(204);
    expect(await categoryOverrides(owner, guild.id, category.id)).toEqual([]);
  });
});
