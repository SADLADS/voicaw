import { PERMISSIONS, PERMISSION_GROUPS, colorToHex } from './permissions';

// How the guild audit log (server/auditLog.js) reads: a sentence per entry, and lines for what
// changed. Sentences are lists of parts: plain strings, and { name } (a person, role, channel or
// thing, drawn in bold).

// The action filter's choices, and the actions each covers.
export const AUDIT_FILTERS = [
  { key: 'messages', label: 'Messages', actions: ['message_delete', 'message_pin', 'message_unpin'] },
  { key: 'members', label: 'Members', actions: ['member_kick', 'member_ban_add', 'member_ban_remove', 'member_role_update', 'guild_owner_transfer'] },
  { key: 'roles', label: 'Roles', actions: ['role_create', 'role_update', 'role_delete'] },
  {
    key: 'channels',
    label: 'Channels',
    actions: ['channel_create', 'channel_update', 'channel_delete', 'channel_override_update', 'category_create', 'category_update', 'category_delete'],
  },
  { key: 'invites', label: 'Invites', actions: ['invite_create', 'invite_delete'] },
  { key: 'emoji', label: 'Emoji', actions: ['emoji_create', 'emoji_update', 'emoji_delete'] },
  { key: 'webhooks', label: 'Webhooks', actions: ['webhook_create', 'webhook_update', 'webhook_delete'] },
  { key: 'guild', label: 'Guild settings', actions: ['guild_update', 'audit_log_clear'] },
];

// What the owner can clear (server/auditLog.js CLEAR_CHOICES): entries older than these days, 0 all.
export const CLEAR_CHOICES = [
  [30, 'Older than 30 days'],
  [90, 'Older than 90 days'],
  [365, 'Older than a year'],
  [0, 'Everything'],
];

const PERMISSION_LABELS = Object.fromEntries(
  PERMISSION_GROUPS.flatMap((group) => group.items.map(([key, label]) => [PERMISSIONS[key], label]))
);

// The labels of the permissions in `bits`.
export function permissionNames(bits) {
  return Object.entries(PERMISSION_LABELS).filter(([bit]) => (bits & Number(bit)) !== 0).map(([, label]) => label);
}

const channel = (name) => ({ name: `#${name ?? 'deleted-channel'}` });
const CHANNEL_KINDS = { voice: 'voice ', list: 'list ' };

// The sentence for `entry`. `names` has `user(id)` and `webhook(id, fallback)`, which give a
// display name. -> [string | { name }]
export function describeEntry(entry, names) {
  const d = entry.details ?? {};
  const actor = entry.actor_id != null
    ? { name: names.user(entry.actor_id) }
    : { name: names.webhook(entry.actor_webhook_id, d.webhookName ?? 'A webhook') };
  const target = () => (entry.target_type === 'webhook'
    ? { name: names.webhook(Number(entry.target_id), d.webhookName ?? d.name ?? 'a webhook') }
    : { name: names.user(Number(entry.target_id)) });

  switch (entry.action) {
    case 'message_delete': {
      const own = entry.target_type === 'user' && entry.actor_id != null && String(entry.actor_id) === entry.target_id;
      const ownWebhook = entry.target_type === 'webhook' && entry.actor_webhook_id != null;
      return own || ownWebhook
        ? [actor, ' deleted their own message in ', channel(d.channelName)]
        : [actor, ' deleted a message by ', target(), ' in ', channel(d.channelName)];
    }
    case 'message_pin': return [actor, ' pinned a message by ', target(), ' in ', channel(d.channelName)];
    case 'message_unpin': return [actor, ' unpinned a message by ', target(), ' in ', channel(d.channelName)];
    case 'member_kick': return [actor, ' kicked ', target()];
    case 'member_ban_add': return [actor, ' banned ', target()];
    case 'member_ban_remove': return [actor, ' unbanned ', target()];
    case 'member_role_update': return [actor, ' changed the roles of ', target()];
    case 'guild_owner_transfer': return [actor, ' made ', target(), ' the owner'];
    case 'role_create': return [actor, ' created the role ', { name: d.name }];
    case 'role_update': return [actor, ' changed the role ', { name: d.name }];
    case 'role_delete': return [actor, ' deleted the role ', { name: d.name }];
    case 'channel_create': return [actor, ` created the ${CHANNEL_KINDS[d.type] ?? ''}channel `, channel(d.name)];
    case 'channel_update': return [actor, ' changed the channel ', channel(d.name)];
    case 'channel_delete': return [actor, ` deleted the ${CHANNEL_KINDS[d.type] ?? ''}channel `, channel(d.name)];
    case 'channel_override_update': {
      const who = entry.target_type === 'role' ? { name: d.targetName ?? 'a role' } : target();
      return [actor, ' changed the permissions of ', who, ' in ', channel(d.channelName)];
    }
    case 'category_create': return [actor, ' created the category ', { name: d.name }];
    case 'category_update': return [actor, ' renamed a category to ', { name: d.name }];
    case 'category_delete': return [actor, ' deleted the category ', { name: d.name }];
    case 'invite_create': return [actor, ' created the invite ', { name: d.code }];
    case 'invite_delete': return [actor, ' revoked the invite ', { name: d.code }];
    case 'emoji_create': return [actor, ' added the emoji ', { name: `:${d.name}:` }];
    case 'emoji_update': return [actor, ' renamed the emoji ', { name: `:${d.changes?.name?.[0] ?? d.name}:` }];
    case 'emoji_delete': return [actor, ' deleted the emoji ', { name: `:${d.name}:` }];
    case 'webhook_create': return [actor, ' created the webhook ', { name: d.name }, ' in ', channel(d.channelName)];
    case 'webhook_update': return [actor, ' changed the webhook ', { name: d.name }];
    case 'webhook_delete': return [actor, ' deleted the webhook ', { name: d.name }];
    case 'guild_update': return [actor, ' changed the guild settings'];
    case 'audit_log_clear': {
      const what = d.olderThanDays ? `entries older than ${clearAge(d.olderThanDays)}` : 'the whole audit log';
      return [actor, ` cleared ${what} (${d.deleted} ${d.deleted === 1 ? 'entry' : 'entries'})`];
    }
    default: return [actor, ` did something (${entry.action})`];
  }
}

const FIELD_LABELS = {
  name: 'Name', topic: 'Topic', category: 'Category', color: 'Colour', hoist: 'Shown separately',
  mentionable: 'Anyone can mention it', channel: 'Channel', permissions: 'Permissions',
};

function showValue(field, value) {
  if (value === null || value === undefined || value === '') return 'none';
  if (field === 'color') return colorToHex(value);
  if (field === 'hoist' || field === 'mentionable') return value ? 'yes' : 'no';
  if (field === 'channel') return `#${value}`;
  return String(value);
}

const OVERRIDE_STATES = { allow: 'allowed', deny: 'denied', inherit: 'not set' };
const overrideState = (o, bit) => ((o.allow & bit) ? 'allow' : (o.deny & bit) ? 'deny' : 'inherit');

// What changed, as lines of text ("Name: old → new", "Granted: Kick Members", ...).
export function entryChanges(entry) {
  const d = entry.details ?? {};
  const lines = [];
  for (const [field, [before, after]] of Object.entries(d.changes ?? {})) {
    if (field === 'permissions') {
      const granted = permissionNames(after & ~before);
      const revoked = permissionNames(before & ~after);
      if (granted.length) lines.push(`Granted: ${granted.join(', ')}`);
      if (revoked.length) lines.push(`Revoked: ${revoked.join(', ')}`);
    } else {
      lines.push(`${FIELD_LABELS[field] ?? field}: ${showValue(field, before)} → ${showValue(field, after)}`);
    }
  }
  if (d.changes?.avatar || d.avatar) lines.push(`Picture ${d.changes?.avatar ?? d.avatar}`);
  if (d.icon) lines.push(`Icon ${d.icon}`);
  if (entry.action === 'role_create' && d.permissions) lines.push(`Permissions: ${permissionNames(d.permissions).join(', ')}`);
  if (entry.action === 'member_role_update') {
    if (d.added?.length) lines.push(`Added: ${d.added.map((r) => r.name).join(', ')}`);
    if (d.removed?.length) lines.push(`Removed: ${d.removed.map((r) => r.name).join(', ')}`);
  }
  if (entry.action === 'channel_override_update' && d.before && d.after) {
    const bits = (d.before.allow | d.before.deny | d.after.allow | d.after.deny);
    for (const [bit, label] of Object.entries(PERMISSION_LABELS)) {
      if (!(bits & Number(bit))) continue;
      const was = overrideState(d.before, Number(bit));
      const now = overrideState(d.after, Number(bit));
      if (was !== now) lines.push(`${label}: ${OVERRIDE_STATES[was]} → ${OVERRIDE_STATES[now]}`);
    }
  }
  if (entry.action === 'invite_create') {
    lines.push(d.maxUses ? `Up to ${d.maxUses} ${d.maxUses === 1 ? 'use' : 'uses'}` : 'No use limit');
    lines.push(d.maxAge ? `Expires after ${formatAge(d.maxAge)}` : 'Never expires');
  }
  return lines;
}

function clearAge(days) {
  if (days === 365) return 'a year';
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

function formatAge(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400} ${seconds === 86400 ? 'day' : 'days'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} ${seconds === 3600 ? 'hour' : 'hours'}`;
  return `${Math.round(seconds / 60)} minutes`;
}
