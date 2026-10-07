import { PERMISSIONS, PERMISSION_GROUPS, colorToHex } from './permissions';
import { formatDateTime } from './dateFormat';
import { customEmojiToText } from '../emoji/customEmoji';
import { t } from '../i18n';

// How the guild audit log (server/auditLog.js) reads: a sentence per entry, and lines for what
// changed. Sentences are lists of parts: plain strings, and { name } (a person, role, channel or
// thing, drawn in bold). Each sentence is one translation (guildAdmin.auditLog.entries) with the
// bold parts as {{placeholders}}, cut up around them.

// The action filter's choices, and the actions each covers.
export const AUDIT_FILTERS = [
  { key: 'messages', label: t('guildAdmin.auditLog.filters.messages'), actions: ['message_delete', 'message_pin', 'message_unpin', 'document_delete'] },
  { key: 'members', label: t('guildAdmin.auditLog.filters.members'), actions: ['member_kick', 'member_ban_add', 'member_ban_remove', 'member_role_update', 'guild_owner_transfer', 'bot_add'] },
  { key: 'roles', label: t('guildAdmin.auditLog.filters.roles'), actions: ['role_create', 'role_update', 'role_delete'] },
  {
    key: 'channels',
    label: t('guildAdmin.auditLog.filters.channels'),
    actions: [
      'channel_create', 'channel_update', 'channel_delete', 'channel_override_update', 'category_create', 'category_update', 'category_delete',
      'thread_create', 'thread_update', 'thread_delete',
    ],
  },
  { key: 'invites', label: t('guildAdmin.auditLog.filters.invites'), actions: ['invite_create', 'invite_delete', 'vanity_update'] },
  { key: 'emoji', label: t('guildAdmin.auditLog.filters.emoji'), actions: ['emoji_create', 'emoji_update', 'emoji_delete'] },
  { key: 'webhooks', label: t('guildAdmin.auditLog.filters.webhooks'), actions: ['webhook_create', 'webhook_update', 'webhook_delete'] },
  { key: 'events', label: t('guildAdmin.auditLog.filters.events'), actions: ['event_create', 'event_update', 'event_delete'] },
  { key: 'guild', label: t('guildAdmin.auditLog.filters.guild'), actions: ['guild_update', 'audit_log_clear'] },
];

// What the owner can clear (server/auditLog.js CLEAR_CHOICES): entries older than these days, 0 all.
// [days, label, the question asked first]
export const CLEAR_CHOICES = [
  [30, t('guildAdmin.auditLog.clear.choices.days30'), t('guildAdmin.auditLog.clear.confirm.days30')],
  [90, t('guildAdmin.auditLog.clear.choices.days90'), t('guildAdmin.auditLog.clear.confirm.days90')],
  [365, t('guildAdmin.auditLog.clear.choices.year'), t('guildAdmin.auditLog.clear.confirm.year')],
  [0, t('guildAdmin.auditLog.clear.choices.everything'), t('guildAdmin.auditLog.clear.confirm.everything')],
];

// Permission names (PERMISSIONS' keys) by bit.
const PERMISSION_KEYS = Object.fromEntries(
  PERMISSION_GROUPS.flatMap((group) => group.items.map((key) => [PERMISSIONS[key], key]))
);
const permissionLabel = (key) => t(`guildAdmin.permissions.${key}.label`);

// The labels of the permissions in `bits`.
export function permissionNames(bits) {
  return Object.entries(PERMISSION_KEYS).filter(([bit]) => (bits & Number(bit)) !== 0).map(([, key]) => permissionLabel(key));
}

const channel = (name) => ({ name: `#${name ?? t('guildAdmin.auditLog.deletedChannel')}` });
const channelKind = (type) => (['voice', 'list', 'doc'].includes(type) ? type : 'text');

// The translation guildAdmin.auditLog.entries.<key>, with `parts` ({ actor: { name }, ... }) in
// bold and `values` as plain text. -> [string | { name }]
const MARK = '\u0001';
const MARKED = new RegExp(`${MARK}(\\w+)${MARK}`);
function sentence(key, parts, values = {}) {
  const marked = Object.fromEntries(Object.keys(parts).map((part) => [part, `${MARK}${part}${MARK}`]));
  return t(`guildAdmin.auditLog.entries.${key}`, { ...values, ...marked })
    .split(MARKED)
    .map((piece, i) => (i % 2 ? parts[piece] : piece))
    .filter((piece) => piece !== '');
}

// The sentence for `entry`. `names` has `user(id)` and `webhook(id, fallback)`, which give a
// display name. -> [string | { name }]
export function describeEntry(entry, names) {
  const d = entry.details ?? {};
  const actor = entry.actor_id != null
    ? { name: names.user(entry.actor_id) }
    : { name: names.webhook(entry.actor_webhook_id, d.webhookName ?? t('guildAdmin.auditLog.aWebhookStart')) };
  const target = () => (entry.target_type === 'webhook'
    ? { name: names.webhook(Number(entry.target_id), d.webhookName ?? d.name ?? t('guildAdmin.auditLog.aWebhook')) }
    : { name: names.user(Number(entry.target_id)) });
  const named = (name) => ({ name });

  switch (entry.action) {
    case 'message_delete': {
      const own = entry.target_type === 'user' && entry.actor_id != null && String(entry.actor_id) === entry.target_id;
      const ownWebhook = entry.target_type === 'webhook' && entry.actor_webhook_id != null;
      return own || ownWebhook
        ? sentence('messageDeleteOwn', { actor, channel: channel(d.channelName) })
        : sentence('messageDelete', { actor, target: target(), channel: channel(d.channelName) });
    }
    case 'message_pin': return sentence('messagePin', { actor, target: target(), channel: channel(d.channelName) });
    case 'message_unpin': return sentence('messageUnpin', { actor, target: target(), channel: channel(d.channelName) });
    case 'document_delete': {
      const own = entry.actor_id != null && String(entry.actor_id) === entry.target_id;
      return own
        ? sentence('documentDeleteOwn', { actor, channel: channel(d.channelName) })
        : sentence('documentDelete', { actor, target: target(), channel: channel(d.channelName) });
    }
    case 'member_kick': return sentence('memberKick', { actor, target: target() });
    case 'member_ban_add': return sentence('memberBan', { actor, target: target() });
    case 'member_ban_remove': return sentence('memberUnban', { actor, target: target() });
    case 'bot_add': return sentence('botAdd', { actor, target: target() });
    case 'member_role_update': return sentence('memberRoleUpdate', { actor, target: target() });
    case 'guild_owner_transfer': return sentence('ownerTransfer', { actor, target: target() });
    case 'role_create': return sentence('roleCreate', { actor, role: named(d.name) });
    case 'role_update': return sentence('roleUpdate', { actor, role: named(d.name) });
    case 'role_delete': return sentence('roleDelete', { actor, role: named(d.name) });
    case 'channel_create': return d.clonedFrom
      ? sentence(`channelClone.${channelKind(d.type)}`, { actor, channel: channel(d.name), source: channel(d.clonedFrom) })
      : sentence(`channelCreate.${channelKind(d.type)}`, { actor, channel: channel(d.name) });
    case 'channel_update': return sentence('channelUpdate', { actor, channel: channel(d.name) });
    case 'channel_delete': return sentence(`channelDelete.${channelKind(d.type)}`, { actor, channel: channel(d.name) });
    case 'channel_override_update': {
      const who = entry.target_type === 'role' ? { name: d.targetName ?? t('guildAdmin.auditLog.aRole') } : target();
      return sentence('channelOverrideUpdate', { actor, target: who, channel: channel(d.channelName) });
    }
    case 'thread_create': return sentence('threadCreate', { actor, thread: named(d.name), channel: channel(d.channelName) });
    case 'thread_update': return sentence('threadUpdate', { actor, thread: named(d.name) });
    case 'thread_delete': return sentence('threadDelete', { actor, thread: named(d.name), channel: channel(d.channelName) });
    case 'category_create': return sentence('categoryCreate', { actor, category: named(d.name) });
    case 'category_update': return sentence('categoryUpdate', { actor, category: named(d.name) });
    case 'category_delete': return sentence('categoryDelete', { actor, category: named(d.name) });
    case 'invite_create': return sentence('inviteCreate', { actor, invite: named(d.code) });
    case 'invite_delete': return sentence('inviteDelete', { actor, invite: named(d.code) });
    case 'vanity_update': return d.after
      ? sentence('vanitySet', { actor, invite: named(d.after) })
      : sentence('vanityRemove', { actor, invite: named(d.before) });
    case 'emoji_create': return sentence('emojiCreate', { actor, emoji: named(`:${d.name}:`) });
    case 'emoji_update': return sentence('emojiUpdate', { actor, emoji: named(`:${d.changes?.name?.[0] ?? d.name}:`) });
    case 'emoji_delete': return sentence('emojiDelete', { actor, emoji: named(`:${d.name}:`) });
    case 'webhook_create': return sentence('webhookCreate', { actor, webhook: named(d.name), channel: channel(d.channelName) });
    case 'webhook_update': return sentence('webhookUpdate', { actor, webhook: named(d.name) });
    case 'webhook_delete': return sentence('webhookDelete', { actor, webhook: named(d.name) });
    case 'event_create': return sentence('eventCreate', { actor, event: named(d.name) });
    case 'event_update': return sentence('eventUpdate', { actor, event: named(d.name) });
    case 'event_delete': return sentence('eventDelete', { actor, event: named(d.name) });
    case 'guild_update': return sentence('guildUpdate', { actor });
    case 'audit_log_clear': return d.olderThanDays
      ? sentence('auditLogClearOlder', { actor }, { age: clearAge(d.olderThanDays), count: d.deleted })
      : sentence('auditLogClearAll', { actor }, { count: d.deleted });
    default: return sentence('unknown', { actor }, { action: entry.action });
  }
}

const FIELDS = [
  'name', 'topic', 'category', 'color', 'hoist', 'mentionable', 'channel', 'permissions', 'nsfw', 'archived',
  'description', 'location', 'start_time', 'end_time', 'all_day', 'emoji',
];
const fieldLabel = (field) => (FIELDS.includes(field) ? t(`guildAdmin.auditLog.fields.${field}`) : field);

function showValue(field, value) {
  if (value === null || value === undefined || value === '') return t('guildAdmin.auditLog.values.none');
  if (field === 'color') return colorToHex(value);
  if (field === 'emoji') return customEmojiToText(value);
  if (['hoist', 'mentionable', 'nsfw', 'archived', 'all_day'].includes(field)) return value ? t('guildAdmin.auditLog.values.yes') : t('guildAdmin.auditLog.values.no');
  if (field === 'channel') return `#${value}`;
  if (field === 'start_time' || field === 'end_time') return formatDateTime(value * 1000);
  return String(value);
}

// An override's state of a permission: allow, deny or inherit (guildAdmin.auditLog.overrideStates).
const overrideState = (o, bit) => ((o.allow & bit) ? 'allow' : (o.deny & bit) ? 'deny' : 'inherit');
const change = (field, before, after) => t('guildAdmin.auditLog.changes.change', { field, before, after });

// What changed, as lines of text ("Name: old → new", "Granted: Kick Members", ...).
export function entryChanges(entry) {
  const d = entry.details ?? {};
  const lines = [];
  for (const [field, [before, after]] of Object.entries(d.changes ?? {})) {
    if (field === 'permissions') {
      const granted = permissionNames(after & ~before);
      const revoked = permissionNames(before & ~after);
      if (granted.length) lines.push(t('guildAdmin.auditLog.changes.granted', { list: granted.join(', ') }));
      if (revoked.length) lines.push(t('guildAdmin.auditLog.changes.revoked', { list: revoked.join(', ') }));
    } else {
      lines.push(change(fieldLabel(field), showValue(field, before), showValue(field, after)));
    }
  }
  const avatar = d.changes?.avatar ?? d.avatar;
  if (avatar) lines.push(avatar === 'removed' ? t('guildAdmin.auditLog.changes.pictureRemoved') : t('guildAdmin.auditLog.changes.pictureChanged'));
  if (d.icon) lines.push(d.icon === 'removed' ? t('guildAdmin.auditLog.changes.iconRemoved') : t('guildAdmin.auditLog.changes.iconChanged'));
  if (d.cover) lines.push(t(`guildAdmin.auditLog.changes.cover.${d.cover}`));
  if (d.repeat) lines.push(t(`guildAdmin.auditLog.changes.repeat.${d.repeat}`));
  if (entry.action === 'role_create' && d.permissions) lines.push(t('guildAdmin.auditLog.changes.permissions', { list: permissionNames(d.permissions).join(', ') }));
  if (entry.action === 'member_role_update') {
    if (d.added?.length) lines.push(t('guildAdmin.auditLog.changes.rolesAdded', { list: d.added.map((r) => r.name).join(', ') }));
    if (d.removed?.length) lines.push(t('guildAdmin.auditLog.changes.rolesRemoved', { list: d.removed.map((r) => r.name).join(', ') }));
  }
  if (entry.action === 'channel_override_update' && d.before && d.after) {
    const bits = (d.before.allow | d.before.deny | d.after.allow | d.after.deny);
    for (const [bit, key] of Object.entries(PERMISSION_KEYS)) {
      if (!(bits & Number(bit))) continue;
      const was = overrideState(d.before, Number(bit));
      const now = overrideState(d.after, Number(bit));
      if (was !== now) {
        lines.push(change(permissionLabel(key), t(`guildAdmin.auditLog.overrideStates.${was}`), t(`guildAdmin.auditLog.overrideStates.${now}`)));
      }
    }
  }
  if (entry.action === 'vanity_update' && d.before && d.after) {
    lines.push(t('guildAdmin.auditLog.changes.vanityWas', { code: d.before }));
  }
  if (entry.action === 'invite_create') {
    lines.push(d.maxUses ? t('guildAdmin.auditLog.changes.maxUses', { count: d.maxUses }) : t('guildAdmin.auditLog.changes.noUseLimit'));
    lines.push(d.maxAge ? t('guildAdmin.auditLog.changes.expiresAfter', { age: formatAge(d.maxAge) }) : t('guildAdmin.auditLog.changes.neverExpires'));
  }
  return lines;
}

function clearAge(days) {
  if (days === 365) return t('guildAdmin.auditLog.age.year');
  return t('guildAdmin.auditLog.age.days', { count: days });
}

function formatAge(seconds) {
  if (seconds % 86400 === 0) return t('guildAdmin.auditLog.age.days', { count: seconds / 86400 });
  if (seconds % 3600 === 0) return t('guildAdmin.auditLog.age.hours', { count: seconds / 3600 });
  return t('guildAdmin.auditLog.age.minutes', { count: Math.round(seconds / 60) });
}
