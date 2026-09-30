const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, ALL_PERMISSIONS, CHANNEL_PERMISSIONS, has } = require('../permissions');
const {
  MAX_ROLE_NAME,
  ROLE_COLUMNS,
  getMember,
  getChannelAccess,
  getMemberListEntry,
  sendToGuild,
  announceGuildUpdate,
  cleanName,
} = require('../guilds');
const { requireMember, requirePermission, outranks } = require('./guilds');

// Roles (create, edit, delete, reorder, give to members) and channel permission overrides.
// Everything here needs Manage Roles, and only reaches below the caller's own highest role
// (the owner is above all). Nobody can hand out a permission they don't have themselves.
const router = express.Router();

const manageRoles = [authenticateJWT, requireMember, requirePermission(PERMISSIONS.MANAGE_ROLES)];

// Checks a role colour: null (none) or 0xRRGGBB.
const validColor = (color) => color === null || (Number.isInteger(color) && color >= 0 && color <= 0xffffff);
const validBits = (bits, mask = ALL_PERMISSIONS) => Number.isInteger(bits) && bits >= 0 && (bits & ~mask) === 0;

// Whether `member` may give out every permission in `bits`.
const mayGrant = (member, bits) => (bits & ~member.permissions) === 0;

async function findRole(guildId, roleId) {
  return db.get(`SELECT ${ROLE_COLUMNS} FROM guild_roles WHERE id = ? AND guild_id = ?`, [roleId, guildId]);
}

// Renumbers the guild's roles 1..n (bottom to top, @everyone stays 0) in the given order
// (top first), or their current order.
async function renumberRoles(guildId, topFirstIds) {
  const ids = topFirstIds ?? (await db.all(
    'SELECT id FROM guild_roles WHERE guild_id = ? AND is_everyone = 0 ORDER BY position DESC, id',
    [guildId]
  )).map((r) => r.id);
  for (const [index, id] of ids.entries()) {
    await db.run('UPDATE guild_roles SET position = ? WHERE id = ?', [ids.length - index, id]);
  }
}

// A new role goes at the bottom (just above @everyone), like in Discord.
router.post('/guilds/:guildId/roles', manageRoles, async (req, res) => {
  const { color = null, permissions = 0, hoist = false, mentionable = false } = req.body ?? {};
  const name = req.body?.name === undefined ? 'new role' : cleanName(req.body.name, MAX_ROLE_NAME);
  if (!name) return res.status(400).json({ error: `Role names are 1–${MAX_ROLE_NAME} characters` });
  if (!validColor(color)) return res.status(400).json({ error: 'Invalid colour' });
  if (!validBits(permissions)) return res.status(400).json({ error: 'Invalid permissions' });
  if (!mayGrant(req.member, permissions)) return res.status(403).json({ error: "You can't give permissions you don't have" });

  await db.run('UPDATE guild_roles SET position = position + 1 WHERE guild_id = ? AND is_everyone = 0', [req.guild.id]);
  const { lastID } = await db.run(
    'INSERT INTO guild_roles (guild_id, name, color, position, permissions, hoist, mentionable) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [req.guild.id, name, color, permissions, hoist ? 1 : 0, mentionable ? 1 : 0]
  );
  await announceGuildUpdate(req.guild.id);
  res.status(201).json(await findRole(req.guild.id, lastID));
});

// Change a role below yours: `name`, `color`, `permissions`, `hoist` (shown separately in the
// member list), `mentionable` (anyone may @mention it). @everyone can only have its permissions
// changed.
router.patch('/guilds/:guildId/roles/:roleId', manageRoles, async (req, res) => {
  const role = await findRole(req.guild.id, Number(req.params.roleId));
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.position >= req.member.highest) return res.status(403).json({ error: 'That role is as high as yours or higher' });

  const body = req.body ?? {};
  const updates = [];
  const params = [];
  if (role.is_everyone && (body.name !== undefined || body.color !== undefined || body.hoist !== undefined || body.mentionable !== undefined)) {
    return res.status(400).json({ error: '@everyone can only have its permissions changed' });
  }
  if (body.name !== undefined) {
    const name = cleanName(body.name, MAX_ROLE_NAME);
    if (!name) return res.status(400).json({ error: `Role names are 1–${MAX_ROLE_NAME} characters` });
    updates.push('name = ?');
    params.push(name);
  }
  if (body.color !== undefined) {
    if (!validColor(body.color)) return res.status(400).json({ error: 'Invalid colour' });
    updates.push('color = ?');
    params.push(body.color);
  }
  if (body.hoist !== undefined) {
    updates.push('hoist = ?');
    params.push(body.hoist ? 1 : 0);
  }
  if (body.mentionable !== undefined) {
    updates.push('mentionable = ?');
    params.push(body.mentionable ? 1 : 0);
  }
  if (body.permissions !== undefined) {
    if (!validBits(body.permissions)) return res.status(400).json({ error: 'Invalid permissions' });
    if (!mayGrant(req.member, body.permissions & ~role.permissions)) {
      return res.status(403).json({ error: "You can't give permissions you don't have" });
    }
    updates.push('permissions = ?');
    params.push(body.permissions);
  }
  if (updates.length) {
    await db.run(`UPDATE guild_roles SET ${updates.join(', ')} WHERE id = ?`, [...params, role.id]);
    await announceGuildUpdate(req.guild.id);
  }
  res.json(await findRole(req.guild.id, role.id));
});

// Deletes a role below yours; its members lose it.
router.delete('/guilds/:guildId/roles/:roleId', manageRoles, async (req, res) => {
  const role = await findRole(req.guild.id, Number(req.params.roleId));
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_everyone) return res.status(400).json({ error: "@everyone can't be deleted" });
  if (role.position >= req.member.highest) return res.status(403).json({ error: 'That role is as high as yours or higher' });

  const holders = await db.all('SELECT user_id FROM guild_member_roles WHERE role_id = ?', [role.id]);
  await db.run('DELETE FROM guild_member_roles WHERE role_id = ?', [role.id]);
  await db.run(`DELETE FROM guild_channel_overrides WHERE target_type = 'role' AND target_id = ?`, [role.id]);
  await db.run('DELETE FROM guild_roles WHERE id = ?', [role.id]);
  await renumberRoles(req.guild.id);

  await announceGuildUpdate(req.guild.id);
  for (const { user_id: userId } of holders) {
    const entry = await getMemberListEntry(req.guild.id, userId);
    await sendToGuild(req.guild.id, { type: 'guild_member_update', guildId: req.guild.id, userId, roleIds: entry.role_ids });
  }
  res.json({ success: true });
});

// Reorders the roles: `roleIds` is every role but @everyone, top first. Roles at or above your
// own highest must stay where they are.
router.put('/guilds/:guildId/roles/order', manageRoles, async (req, res) => {
  const { roleIds } = req.body ?? {};
  const current = req.member.allRoles.filter((r) => !r.is_everyone); // top first
  const sameIds = Array.isArray(roleIds) && roleIds.length === current.length &&
    new Set(roleIds).size === roleIds.length && roleIds.every((id) => current.some((r) => r.id === id));
  if (!sameIds) return res.status(400).json({ error: 'roleIds must list every role once' });
  const moved = current.some((role, index) => role.position >= req.member.highest && roleIds[index] !== role.id);
  if (moved) return res.status(403).json({ error: "You can't move roles as high as yours or higher" });

  await renumberRoles(req.guild.id, roleIds);
  await announceGuildUpdate(req.guild.id);
  res.json({ success: true });
});

// Sets a member's roles (`roleIds`, without @everyone). Only roles below yours can be added or
// taken away, and only from members below you (or yourself).
router.put('/guilds/:guildId/members/:userId/roles', manageRoles, async (req, res) => {
  const userId = Number(req.params.userId);
  const target = await getMember(req.guild.id, userId);
  if (!target) return res.status(404).json({ error: 'Not a member' });
  if (userId !== req.user.id && !(await outranks(req.member, userId))) {
    return res.status(403).json({ error: 'Their role is as high as yours or higher' });
  }
  const { roleIds } = req.body ?? {};
  const roles = new Map(req.member.allRoles.filter((r) => !r.is_everyone).map((r) => [r.id, r]));
  if (!Array.isArray(roleIds) || new Set(roleIds).size !== roleIds.length || roleIds.some((id) => !roles.has(id))) {
    return res.status(400).json({ error: 'Invalid roles' });
  }
  const before = new Set(target.roles.map((r) => r.id));
  const after = new Set(roleIds);
  const changed = [...new Set([...before, ...after])].filter((id) => before.has(id) !== after.has(id));
  if (changed.some((id) => roles.get(id).position >= req.member.highest)) {
    return res.status(403).json({ error: "You can't give or take roles as high as yours or higher" });
  }

  await db.run('DELETE FROM guild_member_roles WHERE guild_id = ? AND user_id = ?', [req.guild.id, userId]);
  for (const roleId of roleIds) {
    await db.run('INSERT INTO guild_member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', [req.guild.id, userId, roleId]);
  }
  await sendToGuild(req.guild.id, { type: 'guild_member_update', guildId: req.guild.id, userId, roleIds });
  // What they can see may have changed.
  await announceGuildUpdate(req.guild.id);
  res.json({ success: true, roleIds });
});

// ---- Channel overrides ----

// Loads req.channel (a channel of this guild the caller can see) and req.channelPermissions.
async function requireChannel(req, res, next) {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || access.channel.guild_id !== req.guild.id || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  req.channel = access.channel;
  req.channelPermissions = access.permissions;
  next();
}

// The channel's overrides: [{ target_type: 'role' | 'member', target_id, allow, deny }].
router.get('/guilds/:guildId/channels/:channelId/overrides', manageRoles, requireChannel, async (req, res) => {
  res.json(await db.all(
    'SELECT target_type, target_id, allow, deny FROM guild_channel_overrides WHERE channel_id = ? ORDER BY target_type DESC, target_id',
    [req.channel.id]
  ));
});

// Sets (or, with nothing allowed or denied, removes) the override for a role or member.
// Only channel permissions can be overridden, only ones you have here, and only for roles
// below yours.
router.put('/guilds/:guildId/channels/:channelId/overrides/:targetType/:targetId', manageRoles, requireChannel, async (req, res) => {
  const { targetType } = req.params;
  const targetId = Number(req.params.targetId);
  const allow = req.body?.allow ?? 0;
  const deny = req.body?.deny ?? 0;
  if (!validBits(allow, CHANNEL_PERMISSIONS) || !validBits(deny, CHANNEL_PERMISSIONS) || (allow & deny)) {
    return res.status(400).json({ error: 'Invalid permissions' });
  }
  if (targetType === 'role') {
    const role = await findRole(req.guild.id, targetId);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.position >= req.member.highest) return res.status(403).json({ error: 'That role is as high as yours or higher' });
  } else if (targetType === 'member') {
    if (!(await getMember(req.guild.id, targetId))) return res.status(404).json({ error: 'Not a member' });
  } else {
    return res.status(400).json({ error: 'Invalid target' });
  }

  const existing = await db.get(
    'SELECT allow, deny FROM guild_channel_overrides WHERE channel_id = ? AND target_type = ? AND target_id = ?',
    [req.channel.id, targetType, targetId]
  ) ?? { allow: 0, deny: 0 };
  const changedBits = (existing.allow ^ allow) | (existing.deny ^ deny);
  if ((changedBits & ~req.channelPermissions) !== 0) {
    return res.status(403).json({ error: "You can't change permissions you don't have here" });
  }

  if (allow === 0 && deny === 0) {
    await db.run(
      'DELETE FROM guild_channel_overrides WHERE channel_id = ? AND target_type = ? AND target_id = ?',
      [req.channel.id, targetType, targetId]
    );
  } else {
    await db.run(
      `INSERT INTO guild_channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, target_type, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
      [req.channel.id, targetType, targetId, allow, deny]
    );
  }
  await announceGuildUpdate(req.guild.id);
  res.json({ target_type: targetType, target_id: targetId, allow, deny });
});

module.exports = router;
