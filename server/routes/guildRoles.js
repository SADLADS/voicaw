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
const { logAudit, diff } = require('../auditLog');
const { ActionError, withActionErrors } = require('../actionError');

// Roles (create, edit, delete, reorder, give to members) and channel permission overrides.
// Everything here needs Manage Roles, and only reaches below the caller's own highest role
// (the owner is above all). Nobody can hand out a permission they don't have themselves.
// The actions are functions taking the acting member (a member context, guilds.js) so the bot
// API (routes/botApi.js) shares them; they throw ActionError.
const router = express.Router();

const manageRoles = [authenticateJWT, requireMember, requirePermission(PERMISSIONS.MANAGE_ROLES)];

// Checks a role colour: null (none) or 0xRRGGBB.
const validColor = (color) => color === null || (Number.isInteger(color) && color >= 0 && color <= 0xffffff);
const validBits = (bits, mask = ALL_PERMISSIONS) => Number.isInteger(bits) && bits >= 0 && (bits & ~mask) === 0;

// Whether `member` may give out every permission in `bits`.
const mayGrant = (member, bits) => (bits & ~member.permissions) === 0;

// An audit log entry (auditLog.js) for something `actor` did in their guild.
const audit = (actor, entry) => logAudit({ guildId: actor.guild.id, actorId: actor.userId, ...entry });

const requireManageRoles = (actor) => {
  if (!has(actor.permissions, PERMISSIONS.MANAGE_ROLES)) throw new ActionError(403, "You don't have permission to do that");
};

async function findRole(guildId, roleId) {
  return db.get(`SELECT ${ROLE_COLUMNS} FROM guild_roles WHERE id = ? AND guild_id = ?`, [roleId, guildId]);
}

// Renumbers the guild's roles 1..n (bottom to top, @everyone stays 0) in the given order
// (top first), or their current order.
async function renumberRoles(guildId, topFirstIds) {
  await db.transaction(async () => {
    const ids = topFirstIds ?? (await db.all(
      'SELECT id FROM guild_roles WHERE guild_id = ? AND is_everyone = 0 ORDER BY position DESC, id',
      [guildId]
    )).map((r) => r.id);
    for (const [index, id] of ids.entries()) {
      await db.run('UPDATE guild_roles SET position = ? WHERE id = ?', [ids.length - index, id]);
    }
  });
}

// A new role goes at the bottom (just above @everyone), like in Discord. Resolves to it.
async function createRole(actor, body) {
  requireManageRoles(actor);
  const { color = null, permissions = 0, hoist = false, mentionable = false } = body;
  const name = body.name === undefined ? 'new role' : cleanName(body.name, MAX_ROLE_NAME);
  if (!name) throw new ActionError(400, `Role names are 1–${MAX_ROLE_NAME} characters`);
  if (!validColor(color)) throw new ActionError(400, 'Invalid colour');
  if (!validBits(permissions)) throw new ActionError(400, 'Invalid permissions');
  if (!mayGrant(actor, permissions)) throw new ActionError(403, "You can't give permissions you don't have");

  const { lastID } = await db.transaction(async () => {
    await db.run('UPDATE guild_roles SET position = position + 1 WHERE guild_id = ? AND is_everyone = 0', [actor.guild.id]);
    const result = await db.run(
      'INSERT INTO guild_roles (guild_id, name, color, position, permissions, hoist, mentionable) VALUES (?, ?, ?, 1, ?, ?, ?)',
      [actor.guild.id, name, color, permissions, hoist ? 1 : 0, mentionable ? 1 : 0]
    );
    await audit(actor, { action: 'role_create', targetType: 'role', targetId: result.lastID, details: { name, color, permissions } });
    return result;
  });
  await announceGuildUpdate(actor.guild.id);
  return findRole(actor.guild.id, lastID);
}

router.post('/guilds/:guildId/roles', manageRoles, withActionErrors(async (req, res) => {
  res.status(201).json(await createRole(req.member, req.body ?? {}));
}));

// Change a role below yours: `name`, `color`, `permissions`, `hoist` (shown separately in the
// member list), `mentionable` (anyone may @mention it). @everyone can only have its permissions
// changed. Resolves to the role.
async function updateRole(actor, roleId, body) {
  requireManageRoles(actor);
  const role = await findRole(actor.guild.id, roleId);
  if (!role) throw new ActionError(404, 'Role not found', 10011);
  if (role.position >= actor.highest) throw new ActionError(403, 'That role is as high as yours or higher');

  const updates = [];
  const params = [];
  if (role.is_everyone && (body.name !== undefined || body.color !== undefined || body.hoist !== undefined || body.mentionable !== undefined)) {
    throw new ActionError(400, '@everyone can only have its permissions changed');
  }
  if (body.name !== undefined) {
    const name = cleanName(body.name, MAX_ROLE_NAME);
    if (!name) throw new ActionError(400, `Role names are 1–${MAX_ROLE_NAME} characters`);
    updates.push('name = ?');
    params.push(name);
  }
  if (body.color !== undefined) {
    if (!validColor(body.color)) throw new ActionError(400, 'Invalid colour');
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
    if (!validBits(body.permissions)) throw new ActionError(400, 'Invalid permissions');
    if (!mayGrant(actor, body.permissions & ~role.permissions)) throw new ActionError(403, "You can't give permissions you don't have");
    updates.push('permissions = ?');
    params.push(body.permissions);
  }
  if (updates.length) {
    await db.transaction(async () => {
      await db.run(`UPDATE guild_roles SET ${updates.join(', ')} WHERE id = ?`, [...params, role.id]);
      const saved = await findRole(actor.guild.id, role.id);
      const changes = diff(role, { name: saved.name, color: saved.color, permissions: saved.permissions, hoist: saved.hoist, mentionable: saved.mentionable });
      if (Object.keys(changes).length) await audit(actor, { action: 'role_update', targetType: 'role', targetId: role.id, details: { name: saved.name, changes } });
    });
    await announceGuildUpdate(actor.guild.id);
  }
  return findRole(actor.guild.id, role.id);
}

router.patch('/guilds/:guildId/roles/:roleId', manageRoles, withActionErrors(async (req, res) => {
  res.json(await updateRole(req.member, Number(req.params.roleId), req.body ?? {}));
}));

// Deletes a role below yours; its members lose it.
async function deleteRole(actor, roleId) {
  requireManageRoles(actor);
  const role = await findRole(actor.guild.id, roleId);
  if (!role) throw new ActionError(404, 'Role not found', 10011);
  if (role.is_everyone) throw new ActionError(400, "@everyone can't be deleted");
  // A bot's own role goes when the bot leaves (bots.js).
  if (role.bot_id) throw new ActionError(400, "A bot's role can't be deleted");
  if (role.position >= actor.highest) throw new ActionError(403, 'That role is as high as yours or higher');

  const holders = await db.transaction(async () => {
    const userIds = await db.all('SELECT user_id FROM guild_member_roles WHERE role_id = ?', [role.id]);
    await db.run('DELETE FROM guild_member_roles WHERE role_id = ?', [role.id]);
    await db.run(`DELETE FROM guild_channel_overrides WHERE target_type = 'role' AND target_id = ?`, [role.id]);
    await db.run('DELETE FROM guild_roles WHERE id = ?', [role.id]);
    await renumberRoles(actor.guild.id);
    await audit(actor, { action: 'role_delete', targetType: 'role', targetId: role.id, details: { name: role.name, color: role.color } });
    return userIds;
  });

  await announceGuildUpdate(actor.guild.id);
  for (const { user_id: userId } of holders) {
    const entry = await getMemberListEntry(actor.guild.id, userId);
    await sendToGuild(actor.guild.id, { type: 'guild_member_update', guildId: actor.guild.id, userId, roleIds: entry.role_ids });
  }
}

router.delete('/guilds/:guildId/roles/:roleId', manageRoles, withActionErrors(async (req, res) => {
  await deleteRole(req.member, Number(req.params.roleId));
  res.json({ success: true });
}));

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

// Sets member `userId`'s roles (`roleIds`, without @everyone). Only roles below yours can be
// added or taken away, and only from members below you (or yourself).
async function setMemberRoles(actor, userId, roleIds) {
  requireManageRoles(actor);
  const target = await getMember(actor.guild.id, userId);
  if (!target) throw new ActionError(404, 'Not a member', 10007);
  if (userId !== actor.userId && !(await outranks(actor, userId))) {
    throw new ActionError(403, 'Their role is as high as yours or higher');
  }
  const roles = new Map(actor.allRoles.filter((r) => !r.is_everyone).map((r) => [r.id, r]));
  if (!Array.isArray(roleIds) || new Set(roleIds).size !== roleIds.length || roleIds.some((id) => !roles.has(id))) {
    throw new ActionError(400, 'Invalid roles');
  }
  const before = new Set(target.roles.map((r) => r.id));
  const after = new Set(roleIds);
  const changed = [...new Set([...before, ...after])].filter((id) => before.has(id) !== after.has(id));
  // A bot's own role stays with its bot (bots.js).
  if (changed.some((id) => roles.get(id).bot_id)) throw new ActionError(400, "A bot's role can't be given or taken away");
  if (changed.some((id) => roles.get(id).position >= actor.highest)) {
    throw new ActionError(403, "You can't give or take roles as high as yours or higher");
  }

  await db.transaction(async () => {
    await db.run('DELETE FROM guild_member_roles WHERE guild_id = ? AND user_id = ?', [actor.guild.id, userId]);
    for (const roleId of roleIds) {
      await db.run('INSERT INTO guild_member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', [actor.guild.id, userId, roleId]);
    }
    if (changed.length) {
      const named = (ids) => ids.map((id) => ({ id, name: roles.get(id).name }));
      await audit(actor, {
        action: 'member_role_update',
        targetType: 'user',
        targetId: userId,
        details: { added: named(changed.filter((id) => after.has(id))), removed: named(changed.filter((id) => before.has(id))) },
      });
    }
  });
  await sendToGuild(actor.guild.id, { type: 'guild_member_update', guildId: actor.guild.id, userId, roleIds });
  // What they can see may have changed.
  await announceGuildUpdate(actor.guild.id);
}

router.put('/guilds/:guildId/members/:userId/roles', manageRoles, withActionErrors(async (req, res) => {
  const { roleIds } = req.body ?? {};
  await setMemberRoles(req.member, Number(req.params.userId), roleIds);
  res.json({ success: true, roleIds });
}));

// ---- Channel overrides ----

// Loads req.channel (a channel of this guild the caller can see) and req.channelPermissions.
// Threads have no overrides of their own (they follow their channel's).
async function requireChannel(req, res, next) {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || access.channel.guild_id !== req.guild.id || access.channel.type === 'thread' ||
    !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) {
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

// Sets (or, with nothing allowed or denied, removes) `channel`'s override for a role or member
// (`targetType` 'role' or 'member'). `channelPermissions` are the actor's in the channel. Only
// channel permissions can be overridden, only ones you have here, and only for roles below yours.
async function setOverride(actor, channel, channelPermissions, targetType, targetId, { allow = 0, deny = 0 }) {
  requireManageRoles(actor);
  if (!validBits(allow, CHANNEL_PERMISSIONS) || !validBits(deny, CHANNEL_PERMISSIONS) || (allow & deny)) {
    throw new ActionError(400, 'Invalid permissions');
  }
  let targetName = null;
  if (targetType === 'role') {
    const role = await findRole(actor.guild.id, targetId);
    if (!role) throw new ActionError(404, 'Role not found', 10011);
    if (role.position >= actor.highest) throw new ActionError(403, 'That role is as high as yours or higher');
    targetName = role.name;
  } else if (targetType === 'member') {
    if (!(await getMember(actor.guild.id, targetId))) throw new ActionError(404, 'Not a member', 10007);
  } else {
    throw new ActionError(400, 'Invalid target');
  }

  const existing = await db.get(
    'SELECT allow, deny FROM guild_channel_overrides WHERE channel_id = ? AND target_type = ? AND target_id = ?',
    [channel.id, targetType, targetId]
  ) ?? { allow: 0, deny: 0 };
  const changedBits = (existing.allow ^ allow) | (existing.deny ^ deny);
  if ((changedBits & ~channelPermissions) !== 0) {
    throw new ActionError(403, "You can't change permissions you don't have here");
  }

  await db.transaction(async () => {
    if (allow === 0 && deny === 0) {
      await db.run(
        'DELETE FROM guild_channel_overrides WHERE channel_id = ? AND target_type = ? AND target_id = ?',
        [channel.id, targetType, targetId]
      );
    } else {
      await db.run(
        `INSERT INTO guild_channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, target_type, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
        [channel.id, targetType, targetId, allow, deny]
      );
    }
    if (changedBits) {
      await audit(actor, {
        action: 'channel_override_update',
        targetType: targetType === 'role' ? 'role' : 'user',
        targetId,
        channelId: channel.id,
        details: {
          channelName: channel.name,
          channelType: channel.type,
          targetName,
          before: { allow: existing.allow, deny: existing.deny },
          after: { allow, deny },
        },
      });
    }
  });
  await announceGuildUpdate(actor.guild.id);
}

router.put('/guilds/:guildId/channels/:channelId/overrides/:targetType/:targetId', manageRoles, requireChannel, withActionErrors(async (req, res) => {
  const { targetType } = req.params;
  const targetId = Number(req.params.targetId);
  const allow = req.body?.allow ?? 0;
  const deny = req.body?.deny ?? 0;
  await setOverride(req.member, req.channel, req.channelPermissions, targetType, targetId, { allow, deny });
  res.json({ target_type: targetType, target_id: targetId, allow, deny });
}));

module.exports = router;
module.exports.createRole = createRole;
module.exports.updateRole = updateRole;
module.exports.deleteRole = deleteRole;
module.exports.setMemberRoles = setMemberRoles;
module.exports.setOverride = setOverride;
