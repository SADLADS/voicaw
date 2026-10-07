import { describe, it, expect } from 'vitest';
import { AUDIT_FILTERS, describeEntry, entryChanges, permissionNames } from './auditLog';
import { PERMISSIONS } from './permissions';

const names = {
  user: (id) => ({ 1: 'Alice', 2: 'Bob' })[id] ?? 'Someone',
  webhook: (id, fallback) => (id === 9 ? 'Captain Hook' : fallback),
};
const text = (parts) => parts.map((p) => (typeof p === 'string' ? p : `[${p.name}]`)).join('');

describe('audit log wording', () => {
  it('says who deleted whose message, and where', () => {
    const entry = { action: 'message_delete', actor_id: 1, target_type: 'user', target_id: '2', details: { channelName: 'general' } };
    expect(text(describeEntry(entry, names))).toBe('[Alice] deleted a message by [Bob] in [#general]');
    expect(text(describeEntry({ ...entry, target_id: '1' }, names))).toBe('[Alice] deleted their own message in [#general]');
  });

  it('names a webhook acting with its token', () => {
    const entry = { action: 'message_delete', actor_id: null, actor_webhook_id: 9, target_type: 'webhook', target_id: '9', details: { channelName: 'news' } };
    expect(text(describeEntry(entry, names))).toBe('[Captain Hook] deleted their own message in [#news]');
    const gone = { ...entry, actor_webhook_id: 8, target_id: '8', details: { channelName: 'news', webhookName: 'Old Bot' } };
    expect(text(describeEntry(gone, names))).toBe('[Old Bot] deleted their own message in [#news]');
  });

  it('lists what changed', () => {
    expect(entryChanges({
      action: 'role_update',
      details: { changes: { name: ['mods', 'moderators'], color: [null, 0xff0000], permissions: [PERMISSIONS.KICK_MEMBERS, PERMISSIONS.BAN_MEMBERS] } },
    })).toEqual(['Name: mods → moderators', 'Colour: none → #ff0000', 'Granted: Ban Members', 'Revoked: Kick Members']);

    expect(entryChanges({
      action: 'channel_override_update',
      details: { before: { allow: 0, deny: 0 }, after: { allow: PERMISSIONS.VIEW_CHANNEL, deny: PERMISSIONS.SEND_MESSAGES } },
    })).toEqual(['View Channels: not set → allowed', 'Send Messages: not set → denied']);

    expect(entryChanges({ action: 'member_role_update', details: { added: [{ id: 1, name: 'mods' }], removed: [] } })).toEqual(['Added: mods']);
    expect(entryChanges({ action: 'invite_create', details: { maxUses: 1, maxAge: 86400 } })).toEqual(['Up to 1 use', 'Expires after 1 day']);
    expect(entryChanges({
      action: 'guild_update',
      details: { changes: { join_log: [null, 'arrivals'], join_log_leaves: [false, true] } },
    })).toEqual(['Join log: none → #arrivals', 'Join log shows leaves: no → yes']);
  });

  it('says how the vanity invite changed', () => {
    expect(text(describeEntry({ action: 'vanity_update', actor_id: 1, details: { before: 'old', after: 'new' } }, names)))
      .toBe('[Alice] set the vanity invite to [new]');
    expect(entryChanges({ action: 'vanity_update', details: { before: 'old', after: 'new' } })).toEqual(['Was old']);
    expect(text(describeEntry({ action: 'vanity_update', actor_id: 1, details: { before: 'old', after: null } }, names)))
      .toBe('[Alice] removed the vanity invite [old]');
  });

  it('says what the owner cleared', () => {
    expect(text(describeEntry({ action: 'audit_log_clear', actor_id: 1, details: { olderThanDays: 90, deleted: 12 } }, names)))
      .toBe('[Alice] cleared entries older than 90 days (12 entries)');
    expect(text(describeEntry({ action: 'audit_log_clear', actor_id: 1, details: { olderThanDays: 0, deleted: 1 } }, names)))
      .toBe('[Alice] cleared the whole audit log (1 entry)');
  });

  it('labels every permission, and every filter has actions', () => {
    expect(permissionNames(PERMISSIONS.VIEW_AUDIT_LOG)).toEqual(['View Audit Log']);
    for (const filter of AUDIT_FILTERS) expect(filter.actions.length).toBeGreaterThan(0);
  });
});
