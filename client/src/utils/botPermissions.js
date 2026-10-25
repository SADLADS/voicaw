// The bot API's permissions, as Discord's bits (server/discord.js PERMISSION_BITS; a test checks
// the two match): what the developer portal's invite link asks for and what the authorise page
// shows. `ours` is the app's own permission (utils/permissions.js) each one stands for; Discord's
// bits we don't have aren't offered. Labels are developers.permissions.<name>.
import { PERMISSIONS as P } from './permissions';

export const BOT_PERMISSION_GROUPS = [
  {
    id: 'general',
    permissions: [
      { name: 'ADMINISTRATOR', bit: 3, ours: 'ADMINISTRATOR' },
      { name: 'VIEW_CHANNEL', bit: 10, ours: 'VIEW_CHANNEL' },
      { name: 'MANAGE_GUILD', bit: 5, ours: 'MANAGE_GUILD' },
      { name: 'MANAGE_ROLES', bit: 28, ours: 'MANAGE_ROLES' },
      { name: 'MANAGE_CHANNELS', bit: 4, ours: 'MANAGE_CHANNELS' },
      { name: 'MANAGE_GUILD_EXPRESSIONS', bit: 30, ours: 'MANAGE_EMOJIS' },
      { name: 'MANAGE_WEBHOOKS', bit: 29, ours: 'MANAGE_WEBHOOKS' },
      { name: 'VIEW_AUDIT_LOG', bit: 7, ours: 'VIEW_AUDIT_LOG' },
      { name: 'CREATE_EVENTS', bit: 44, ours: 'CREATE_EVENTS' },
      { name: 'MANAGE_EVENTS', bit: 33, ours: 'MANAGE_EVENTS' },
    ],
  },
  {
    id: 'membership',
    permissions: [
      { name: 'CREATE_INSTANT_INVITE', bit: 0, ours: 'CREATE_INVITE' },
      { name: 'KICK_MEMBERS', bit: 1, ours: 'KICK_MEMBERS' },
      { name: 'BAN_MEMBERS', bit: 2, ours: 'BAN_MEMBERS' },
    ],
  },
  {
    id: 'text',
    permissions: [
      { name: 'SEND_MESSAGES', bit: 11, ours: 'SEND_MESSAGES' },
      { name: 'SEND_MESSAGES_IN_THREADS', bit: 38, ours: 'SEND_MESSAGES_IN_THREADS' },
      { name: 'CREATE_PUBLIC_THREADS', bit: 35, ours: 'CREATE_THREADS' },
      { name: 'ADD_REACTIONS', bit: 6, ours: 'ADD_REACTIONS' },
      { name: 'MANAGE_MESSAGES', bit: 13, ours: 'MANAGE_MESSAGES' },
      { name: 'PIN_MESSAGES', bit: 51, ours: 'PIN_MESSAGES' },
      { name: 'MENTION_EVERYONE', bit: 17, ours: 'MENTION_EVERYONE' },
    ],
  },
  {
    id: 'voice',
    permissions: [
      { name: 'CONNECT', bit: 20, ours: 'CONNECT' },
      { name: 'SPEAK', bit: 21, ours: 'SPEAK' },
      { name: 'VOICAW_LISTEN', bit: 61, ours: 'LISTEN' },
      { name: 'STREAM', bit: 9, ours: 'STREAM' },
      { name: 'USE_SOUNDBOARD', bit: 42, ours: 'USE_SOUNDBOARD' },
    ],
  },
  {
    id: 'voicaw',
    permissions: [
      { name: 'VOICAW_EDIT_TASKS', bit: 56, ours: 'EDIT_TASKS' },
      { name: 'VOICAW_CREATE_DOCUMENTS', bit: 57, ours: 'CREATE_DOCUMENTS' },
      { name: 'VOICAW_QUEUE_VIDEOS', bit: 58, ours: 'QUEUE_VIDEOS' },
      { name: 'VOICAW_MANAGE_QUEUE', bit: 59, ours: 'MANAGE_QUEUE' },
      { name: 'VOICAW_CONTROL_PLAYBACK', bit: 60, ours: 'CONTROL_PLAYBACK' },
      { name: 'VOICAW_MANAGE_LEVELS', bit: 62, ours: 'MANAGE_LEVELS' },
    ],
  },
];

export const BOT_PERMISSIONS = BOT_PERMISSION_GROUPS.flatMap((g) => g.permissions);

// The names (BOT_PERMISSIONS' `name`s) as Discord's bitfield: a decimal string, as in a link.
export function toBitfield(names) {
  let bits = 0n;
  for (const p of BOT_PERMISSIONS) if (names.has(p.name)) bits |= 1n << BigInt(p.bit);
  return bits.toString();
}

// A bitfield from a link (a decimal string) as the names it asks for that we offer.
export function fromBitfield(value) {
  let bits;
  try {
    bits = BigInt(/^\d{1,20}$/.test(String(value ?? '')) ? value : 0);
  } catch {
    bits = 0n;
  }
  return new Set(BOT_PERMISSIONS.filter((p) => bits & (1n << BigInt(p.bit))).map((p) => p.name));
}

// Whether someone with `ours` (the app's bits in a guild) can grant permission `p`: only what
// they have themselves (administrators and owners have everything).
export const canGrant = (ours, p) => (ours & P[p.ours]) === P[p.ours];
