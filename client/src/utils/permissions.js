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
};

export const DEFAULT_EVERYONE_PERMISSIONS = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.ADD_REACTIONS | PERMISSIONS.CREATE_INVITE | PERMISSIONS.CONNECT | PERMISSIONS.SPEAK |
  PERMISSIONS.EDIT_TASKS | PERMISSIONS.STREAM;

export const has = (permissions, bit) => ((permissions ?? 0) & bit) === bit;

// What the role editor lists, in groups, with Discord's wording.
export const PERMISSION_GROUPS = [
  {
    title: 'General',
    items: [
      ['VIEW_CHANNEL', 'View Channels', 'Lets members see channels (private channels aside).'],
      ['MANAGE_CHANNELS', 'Manage Channels', 'Lets members create, edit and delete channels and categories.'],
      ['MANAGE_ROLES', 'Manage Roles', 'Lets members create and edit roles below their highest role, give them out, and change channel permissions.'],
      ['MANAGE_GUILD', 'Manage Guild', "Lets members change the guild's name and icon, and see and revoke all invites."],
      ['MANAGE_EMOJIS', 'Manage Emoji', "Lets members add, rename and remove the guild's custom emoji."],
      ['MANAGE_WEBHOOKS', 'Manage Webhooks', 'Lets members create, edit and delete webhooks, which let other apps and services post messages in text channels.'],
      ['VIEW_AUDIT_LOG', 'View Audit Log', "Lets members see the guild's audit log: who deleted which messages, and who changed the guild's settings, channels, roles, invites, emoji and webhooks, or kicked and banned people."],
    ],
  },
  {
    title: 'Membership',
    items: [
      ['CREATE_INVITE', 'Create Invite', 'Lets members invite people to this guild.'],
      ['KICK_MEMBERS', 'Kick Members', 'Lets members remove people ranked below them. They can rejoin with an invite.'],
      ['BAN_MEMBERS', 'Ban Members', 'Lets members remove people ranked below them for good (until unbanned).'],
    ],
  },
  {
    title: 'Text channels',
    items: [
      ['SEND_MESSAGES', 'Send Messages', 'Lets members post in text channels.'],
      ['ADD_REACTIONS', 'Add Reactions', 'Lets members react to messages.'],
      ['MANAGE_MESSAGES', 'Manage Messages', "Lets members delete other people's messages."],
      ['PIN_MESSAGES', 'Pin Messages', 'Lets members pin and unpin messages.'],
      ['MENTION_EVERYONE', 'Mention @everyone, @here and All Roles', 'Lets members notify everyone in a channel (@everyone), everyone online there (@here), and any role, even ones not set to be mentionable.'],
    ],
  },
  {
    title: 'Voice channels',
    items: [
      ['CONNECT', 'Connect', 'Lets members join voice channels and hear others.'],
      ['SPEAK', 'Speak', 'Lets members talk in voice channels. Without it they can only listen.'],
      ['STREAM', 'Video', 'Lets members share their screen in voice channels.'],
    ],
  },
  {
    title: 'List channels',
    items: [
      ['EDIT_TASKS', 'Edit Tasks', 'Lets members add, edit, assign, complete, reorder and delete tasks in list channels. Commenting on tasks follows Send Messages.'],
    ],
  },
  {
    title: 'Advanced',
    items: [
      ['ADMINISTRATOR', 'Administrator', 'Every permission, in every channel, whatever the channel settings. Handle with care.'],
    ],
  },
];

// What a channel override can change (the server refuses anything else), by channel type.
const CHANNEL_PERMISSION_ITEMS = {
  text: [
    ['VIEW_CHANNEL', 'View Channel'],
    ['SEND_MESSAGES', 'Send Messages'],
    ['ADD_REACTIONS', 'Add Reactions'],
    ['MANAGE_MESSAGES', 'Manage Messages'],
    ['PIN_MESSAGES', 'Pin Messages'],
  ],
  voice: [
    ['VIEW_CHANNEL', 'View Channel'],
    ['CONNECT', 'Connect'],
    ['SPEAK', 'Speak'],
    ['STREAM', 'Video'],
  ],
  list: [
    ['VIEW_CHANNEL', 'View Channel'],
    ['EDIT_TASKS', 'Edit Tasks'],
    ['SEND_MESSAGES', 'Comment on Tasks'],
    ['MANAGE_MESSAGES', 'Manage Comments'],
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
