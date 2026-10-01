// Guild permissions, Discord style. A member's permissions are @everyone's plus those of every
// role they have (the owner and ADMINISTRATOR get everything). In a channel, overrides then
// apply in order: @everyone's, then the member's roles' (all denies, then all allows), then the
// member's own. Roles rank by position (@everyone is 0, the bottom); you can only manage roles
// and members below your own highest role, and the owner is above everyone.
//
// The client has the same list in client/src/utils/permissions.js (a test checks they match).

const PERMISSIONS = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  ADD_REACTIONS: 1 << 2,
  MANAGE_MESSAGES: 1 << 3,
  MANAGE_CHANNELS: 1 << 4,
  MANAGE_ROLES: 1 << 5,
  MANAGE_GUILD: 1 << 6,
  CREATE_INVITE: 1 << 7,
  KICK_MEMBERS: 1 << 8,
  BAN_MEMBERS: 1 << 9,
  ADMINISTRATOR: 1 << 10,
  MANAGE_EMOJIS: 1 << 11,
  CONNECT: 1 << 12,
  SPEAK: 1 << 13,
  MENTION_EVERYONE: 1 << 14,
  PIN_MESSAGES: 1 << 15,
  MANAGE_WEBHOOKS: 1 << 16,
  VIEW_AUDIT_LOG: 1 << 17,
  EDIT_TASKS: 1 << 18,
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS).reduce((all, bit) => all | bit, 0);

// The ones a channel override can change.
const CHANNEL_PERMISSIONS = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.ADD_REACTIONS | PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.PIN_MESSAGES | PERMISSIONS.CONNECT |
  PERMISSIONS.SPEAK | PERMISSIONS.EDIT_TASKS;

const DEFAULT_EVERYONE_PERMISSIONS = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.ADD_REACTIONS | PERMISSIONS.CREATE_INVITE | PERMISSIONS.CONNECT | PERMISSIONS.SPEAK |
  PERMISSIONS.EDIT_TASKS;

const has = (permissions, bit) => (permissions & bit) === bit;

// `member` is { isOwner, everyone (role), roles (the member's other roles) }.
function guildPermissions(member) {
  if (member.isOwner) return ALL_PERMISSIONS;
  const permissions = member.roles.reduce((all, role) => all | role.permissions, member.everyone.permissions);
  return has(permissions, PERMISSIONS.ADMINISTRATOR) ? ALL_PERMISSIONS : permissions;
}

// `overrides` are the channel's [{ target_type, target_id, allow, deny }]; `userId` is the member.
function channelPermissions(member, userId, overrides = []) {
  let permissions = guildPermissions(member);
  if (has(permissions, PERMISSIONS.ADMINISTRATOR)) return ALL_PERMISSIONS;

  const apply = (override) => {
    if (override) permissions = (permissions & ~override.deny) | override.allow;
  };
  apply(overrides.find((o) => o.target_type === 'role' && o.target_id === member.everyone.id));

  const roleIds = new Set(member.roles.map((r) => r.id));
  const roleOverrides = overrides.filter((o) => o.target_type === 'role' && roleIds.has(o.target_id));
  apply({
    deny: roleOverrides.reduce((all, o) => all | o.deny, 0),
    allow: roleOverrides.reduce((all, o) => all | o.allow, 0),
  });

  apply(overrides.find((o) => o.target_type === 'member' && o.target_id === userId));
  return permissions;
}

// How high the member ranks: their highest role's position (0 with none), the owner above all.
function highestPosition(member) {
  if (member.isOwner) return Infinity;
  return member.roles.reduce((max, role) => Math.max(max, role.position), 0);
}

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  CHANNEL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  has,
  guildPermissions,
  channelPermissions,
  highestPosition,
};
