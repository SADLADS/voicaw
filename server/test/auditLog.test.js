import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { RETENTION_DAYS } = require('../auditLog.js');

let userCount = 0;
async function makeUser(prefix = 'audit-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-audit-123';
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

// A guild with an owner and `count` other members, and its #general.
async function setUp(count = 2) {
  const owner = await makeUser('owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Audit Guild' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  return { owner, members, guild, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

async function auditLog(user, guildId, query = '') {
  const res = await api.get(user, `/guilds/${guildId}/audit-log${query}`);
  expect(res.status).toBe(200);
  return res.body;
}

// A role with `permissions`, given to `user`.
async function grant(owner, guildId, user, permissions) {
  const role = (await api.post(owner, `/guilds/${guildId}/roles`, { name: 'granted', permissions })).body;
  await api.put(owner, `/guilds/${guildId}/members/${user.id}/roles`, { roleIds: [role.id] });
  return role;
}

describe('guild audit log', () => {
  it('records a deleted message: whose, who deleted it, where and when, never what it said', async () => {
    const { owner, members: [author, mod], guild, general } = await setUp();
    await grant(owner, guild.id, mod, P.MANAGE_MESSAGES);
    const message = (await api.post(author, `/channels/${general.id}/messages`, { content: 'secret words' })).body;
    expect((await api.delete(mod, `/guild-messages/${message.id}`)).status).toBe(200);

    const log = await auditLog(owner, guild.id, '?actions=message_delete');
    expect(log.entries).toHaveLength(1);
    const [entry] = log.entries;
    expect(entry).toMatchObject({
      action: 'message_delete',
      actor_id: mod.id,
      target_type: 'user',
      target_id: String(author.id),
      channel_id: general.id,
      details: { messageId: message.id, sentAt: message.timestamp, channelName: 'general' },
    });
    expect(entry.created_at).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toContain('secret words');
    expect(log.users.map((u) => u.id).sort()).toEqual([author.id, mod.id].sort());

    // Deleting your own message is logged too.
    const own = (await api.post(author, `/channels/${general.id}/messages`, { content: 'oops' })).body;
    await api.delete(author, `/guild-messages/${own.id}`);
    const after = await auditLog(owner, guild.id, '?actions=message_delete');
    expect(after.entries[0]).toMatchObject({ actor_id: author.id, target_id: String(author.id) });
  });

  it('needs View Audit Log (not a default); the owner and administrators have it', async () => {
    const { owner, members: [member, admin], guild } = await setUp();
    expect((await api.get(member, `/guilds/${guild.id}/audit-log`)).status).toBe(403);
    await grant(owner, guild.id, admin, P.ADMINISTRATOR);
    expect((await api.get(admin, `/guilds/${guild.id}/audit-log`)).status).toBe(200);
    await grant(owner, guild.id, member, P.VIEW_AUDIT_LOG);
    expect((await api.get(member, `/guilds/${guild.id}/audit-log`)).status).toBe(200);

    const outsider = await makeUser('outsider');
    expect((await api.get(outsider, `/guilds/${guild.id}/audit-log`)).status).toBe(404);
  });

  it('records moderation, roles, channels, invites and settings', async () => {
    const { owner, members: [a, b], guild, general, everyone } = await setUp();
    await api.patch(owner, `/guilds/${guild.id}`, { name: 'Renamed' });
    const role = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'mods' })).body;
    await api.patch(owner, `/guilds/${guild.id}/roles/${role.id}`, { name: 'moderators', permissions: P.KICK_MEMBERS });
    await api.put(owner, `/guilds/${guild.id}/members/${a.id}/roles`, { roleIds: [role.id] });
    await api.put(owner, `/guilds/${guild.id}/channels/${general.id}/overrides/role/${everyone.id}`, { deny: P.SEND_MESSAGES });
    await api.patch(owner, `/guilds/${guild.id}/channels/${general.id}`, { topic: 'hello' });
    const channel = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'temp' })).body;
    await api.delete(owner, `/guilds/${guild.id}/channels/${channel.id}`);
    const invite = (await api.post(owner, `/guilds/${guild.id}/invites`, { maxUses: 5 })).body;
    await api.delete(owner, `/invites/${invite.code}`);
    await api.delete(a, `/guilds/${guild.id}/members/${b.id}`);
    await api.put(owner, `/guilds/${guild.id}/bans/${b.id}`);
    await api.delete(owner, `/guilds/${guild.id}/bans/${b.id}`);
    await api.delete(owner, `/guilds/${guild.id}/roles/${role.id}`);

    const { entries } = await auditLog(owner, guild.id);
    const byAction = (action) => entries.find((e) => e.action === action);
    expect(byAction('guild_update').details.changes).toEqual({ name: ['Audit Guild', 'Renamed'] });
    expect(byAction('role_create').details.name).toBe('mods');
    expect(byAction('role_update').details.changes).toEqual({ name: ['mods', 'moderators'], permissions: [0, P.KICK_MEMBERS] });
    expect(byAction('member_role_update')).toMatchObject({ target_id: String(a.id), details: { added: [{ id: role.id, name: 'moderators' }], removed: [] } });
    expect(byAction('channel_override_update').details).toMatchObject({
      channelName: 'general', targetName: '@everyone', before: { allow: 0, deny: 0 }, after: { allow: 0, deny: P.SEND_MESSAGES },
    });
    expect(byAction('channel_update').details.changes).toEqual({ topic: [null, 'hello'] });
    expect(byAction('channel_create').details).toEqual({ name: 'temp', type: 'text' });
    expect(byAction('channel_delete').details).toEqual({ name: 'temp', type: 'text' });
    expect(byAction('invite_create').details).toMatchObject({ code: invite.code, maxUses: 5 });
    expect(byAction('invite_delete').details.code).toBe(invite.code);
    expect(byAction('member_kick')).toMatchObject({ actor_id: a.id, target_id: String(b.id) });
    expect(byAction('member_ban_add').target_id).toBe(String(b.id));
    expect(byAction('member_ban_remove').target_id).toBe(String(b.id));
    expect(byAction('role_delete').details.name).toBe('moderators');
    // Newest first.
    expect(entries[0].action).toBe('role_delete');
  });

  it('filters by who did it, and pages', async () => {
    const { owner, members: [a], guild } = await setUp(1);
    await grant(owner, guild.id, a, P.MANAGE_CHANNELS);
    for (let i = 0; i < 5; i++) await api.post(a, `/guilds/${guild.id}/categories`, { name: `c${i}` });

    const mine = await auditLog(owner, guild.id, `?userId=${a.id}`);
    expect(mine.entries.map((e) => e.details.name)).toEqual(['c4', 'c3', 'c2', 'c1', 'c0']);

    const first = await auditLog(owner, guild.id, `?userId=${a.id}&limit=2`);
    expect(first.entries.map((e) => e.details.name)).toEqual(['c4', 'c3']);
    const second = await auditLog(owner, guild.id, `?userId=${a.id}&limit=2&before=${first.next}`);
    expect(second.entries.map((e) => e.details.name)).toEqual(['c2', 'c1']);
    const third = await auditLog(owner, guild.id, `?userId=${a.id}&limit=2&before=${second.next}`);
    expect(third.entries.map((e) => e.details.name)).toEqual(['c0']);
    expect(third.next).toBeNull();
  });

  it("hides entries about channels the reader can't see; a deleted private channel's only from administrators", async () => {
    const { owner, members: [reader, admin], guild } = await setUp();
    await grant(owner, guild.id, reader, P.VIEW_AUDIT_LOG);
    await grant(owner, guild.id, admin, P.ADMINISTRATOR);
    const secret = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'secret', private: true })).body;
    const message = (await api.post(owner, `/channels/${secret.id}/messages`, { content: 'hi' })).body;
    await api.delete(owner, `/guild-messages/${message.id}`);

    const actions = async (user) => (await auditLog(user, guild.id)).entries.filter((e) => e.channel_id === secret.id).map((e) => e.action);
    expect(await actions(reader)).toEqual([]);
    expect(await actions(admin)).toEqual(['message_delete', 'channel_create']);

    // Shown to the reader once they can see it.
    await api.put(owner, `/guilds/${guild.id}/channels/${secret.id}/overrides/member/${reader.id}`, { allow: P.VIEW_CHANNEL });
    expect(await actions(reader)).toEqual(['channel_override_update', 'message_delete', 'channel_create']);

    // Deleted: it was private, so only administrators (and the owner) still see its entries.
    await api.put(owner, `/guilds/${guild.id}/channels/${secret.id}/overrides/member/${reader.id}`, { allow: 0 });
    await api.delete(owner, `/guilds/${guild.id}/channels/${secret.id}`);
    expect(await actions(reader)).toEqual([]);
    expect((await actions(admin))[0]).toBe('channel_delete');
    expect((await actions(owner))[0]).toBe('channel_delete');

    // A public channel's entries stay visible after it's deleted.
    const open = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'open' })).body;
    await api.delete(owner, `/guilds/${guild.id}/channels/${open.id}`);
    const seen = (await auditLog(reader, guild.id)).entries.filter((e) => e.channel_id === open.id).map((e) => e.action);
    expect(seen).toEqual(['channel_delete', 'channel_create']);
  });

  it('records webhooks, and a webhook deleting its own message with its token', async () => {
    const { owner, guild, general } = await setUp(0);
    const hook = (await api.post(owner, `/channels/${general.id}/webhooks`, { name: 'Bot' })).body;
    await api.patch(owner, `/webhooks/${hook.id}`, { name: 'Robot' });
    const sent = await request(app).post(`/api/webhooks/${hook.id}/${hook.token}?wait=true`).send({ content: 'beep' });
    expect(sent.status).toBe(200);
    expect((await request(app).delete(`/api/webhooks/${hook.id}/${hook.token}/messages/${sent.body.id}`)).status).toBe(204);
    await api.delete(owner, `/webhooks/${hook.id}`);

    const { entries, webhooks } = await auditLog(owner, guild.id);
    expect(entries.map((e) => e.action)).toEqual(['webhook_delete', 'message_delete', 'webhook_update', 'webhook_create']);
    const deleted = entries.find((e) => e.action === 'message_delete');
    expect(deleted).toMatchObject({ actor_id: null, actor_webhook_id: Number(hook.id), target_type: 'webhook', target_id: String(hook.id) });
    expect(deleted.details.webhookName).toBe('Robot');
    expect(entries.find((e) => e.action === 'webhook_update').details.changes).toEqual({ name: ['Bot', 'Robot'] });
    expect(webhooks).toEqual([]); // gone now; entries keep its name
  });

  it('drops entries older than the retention period', async () => {
    const { owner, guild } = await setUp(0);
    await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'old' });
    await db.run('UPDATE guild_audit_log SET created_at = created_at - ? WHERE guild_id = ?', [(RETENTION_DAYS + 1) * 86400, guild.id]);
    await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'new' });
    const { entries } = await auditLog(owner, guild.id);
    expect(entries.map((e) => e.details.name)).toEqual(['new']);
  });

  it('is deleted with the guild', async () => {
    const { owner, guild } = await setUp(0);
    await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'x' });
    await api.delete(owner, `/guilds/${guild.id}`);
    expect(await db.get('SELECT COUNT(*) AS n FROM guild_audit_log WHERE guild_id = ?', [guild.id])).toEqual({ n: 0 });
  });
});
