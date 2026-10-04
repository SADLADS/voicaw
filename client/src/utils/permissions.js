// Guild permissions, as the server has them (server/permissions.js; a server test checks the
// two match). The server decides; the client uses these to show only what you can do, and
// to draw roles (colours, member list groups).

export const PERMISSIONS = {
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
  STREAM: 1 << 19,
  CREATE_DOCUMENTS: 1 << 20,
  CREATE_THREADS: 1 << 21,
  SEND_MESSAGES_IN_THREADS: 1 << 22,
  QUEUE_VIDEOS: 1 << 23,
  MANAGE_QUEUE: 1 << 24,
  CONTROL_PLAYBACK: 1 << 25,
};

export const DEFAULT_EVERYONE_PERMISSIONS = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.ADD_REACTIONS | PERMISSIONS.CREATE_INVITE | PERMISSIONS.CONNECT | PERMISSIONS.SPEAK |
  PERMISSIONS.EDIT_TASKS | PERMISSIONS.STREAM | PERMISSIONS.CREATE_DOCUMENTS |
  PERMISSIONS.CREATE_THREADS | PERMISSIONS.SEND_MESSAGES_IN_THREADS | PERMISSIONS.QUEUE_VIDEOS |
  PERMISSIONS.CONTROL_PLAYBACK;

export const has = (permissions, bit) => ((permissions ?? 0) & bit) === bit;

// A thread's permissions from its channel's: posting there follows Send Messages in Threads
// (server/permissions.js threadPermissions).
export function threadPermissions(channelPermissions) {
  const send = has(channelPermissions, PERMISSIONS.SEND_MESSAGES_IN_THREADS) ? PERMISSIONS.SEND_MESSAGES : 0;
  return ((channelPermissions ?? 0) & ~PERMISSIONS.SEND_MESSAGES) | send;
}

// What the role editor lists, in groups. Their names and descriptions (Discord's wording) are
// translations: guildAdmin.permissionGroups.<key>, guildAdmin.permissions.<PERMISSION>.label
// and .description.
export const PERMISSION_GROUPS = [
  { key: 'general', items: ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_GUILD', 'MANAGE_EMOJIS', 'MANAGE_WEBHOOKS', 'VIEW_AUDIT_LOG'] },
  { key: 'membership', items: ['CREATE_INVITE', 'KICK_MEMBERS', 'BAN_MEMBERS'] },
  { key: 'text', items: ['SEND_MESSAGES', 'ADD_REACTIONS', 'MANAGE_MESSAGES', 'PIN_MESSAGES', 'CREATE_THREADS', 'SEND_MESSAGES_IN_THREADS', 'MENTION_EVERYONE'] },
  { key: 'voice', items: ['CONNECT', 'SPEAK', 'STREAM', 'QUEUE_VIDEOS', 'MANAGE_QUEUE', 'CONTROL_PLAYBACK'] },
  { key: 'list', items: ['EDIT_TASKS'] },
  { key: 'doc', items: ['CREATE_DOCUMENTS'] },
  { key: 'advanced', items: ['ADMINISTRATOR'] },
];

// What a channel override can change (the server refuses anything else), by channel type:
// [permission, label key] (guildAdmin.channelPermissions.items.<key>; some read differently here).
const CHANNEL_PERMISSION_ITEMS = {
  text: [
    ['VIEW_CHANNEL', 'viewChannel'],
    ['SEND_MESSAGES', 'sendMessages'],
    ['ADD_REACTIONS', 'addReactions'],
    ['MANAGE_MESSAGES', 'manageMessages'],
    ['PIN_MESSAGES', 'pinMessages'],
    ['CREATE_THREADS', 'createThreads'],
    ['SEND_MESSAGES_IN_THREADS', 'sendMessagesInThreads'],
  ],
  voice: [
    ['VIEW_CHANNEL', 'viewChannel'],
    ['CONNECT', 'connect'],
    ['SPEAK', 'speak'],
    ['STREAM', 'video'],
    ['QUEUE_VIDEOS', 'queueVideos'],
    ['MANAGE_QUEUE', 'manageQueue'],
    ['CONTROL_PLAYBACK', 'controlPlayback'],
  ],
  list: [
    ['VIEW_CHANNEL', 'viewChannel'],
    ['EDIT_TASKS', 'editTasks'],
    ['SEND_MESSAGES', 'commentOnTasks'],
    ['MANAGE_MESSAGES', 'manageComments'],
  ],
  doc: [
    ['VIEW_CHANNEL', 'viewChannel'],
    ['CREATE_DOCUMENTS', 'createDocuments'],
    ['SEND_MESSAGES', 'replyToDocuments'],
    ['ADD_REACTIONS', 'addReactions'],
    ['MANAGE_MESSAGES', 'manageDocuments'],
  ],
};

export const channelPermissionItems = (type) => CHANNEL_PERMISSION_ITEMS[type] ?? CHANNEL_PERMISSION_ITEMS.text;

// A member's roles (from `roles`, the guild's list, highest first), highest first.
export function memberRoles(roles, roleIds) {
  const ids = new Set(roleIds ?? []);
  return (roles ?? []).filter((r) => !r.is_everyone && ids.has(r.id));
}

// Their name colour: that of their highest role with a colour, or null (the normal colour).
export function memberColor(roles, roleIds) {
  const role = memberRoles(roles, roleIds).find((r) => r.color != null);
  return role ? colorToHex(role.color) : null;
}

// How high someone ranks (their highest role's position; the owner above all).
export function memberRank(guild, userId, roleIds) {
  if (guild.owner === userId) return Infinity;
  return memberRoles(guild.roles, roleIds).reduce((max, r) => Math.max(max, r.position), 0);
}

export function colorToHex(color) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function hexToColor(hex) {
  return parseInt(hex.replace('#', ''), 16);
}
