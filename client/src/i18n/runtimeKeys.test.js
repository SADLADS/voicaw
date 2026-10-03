import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import i18n from './index.js';
import { PERMISSIONS, PERMISSION_GROUPS, channelPermissionItems } from '../utils/permissions.js';
import { describeEntry as describeAuditEntry, entryChanges } from '../utils/auditLog.js';

// Keys built at run time, which keys.test.js can't find in the code.
const has = (key) => i18n.exists(key);

describe('translations built at run time', () => {
  it('names and describes every permission, in a group', () => {
    const grouped = PERMISSION_GROUPS.flatMap((group) => {
      expect(has(`guildAdmin.permissionGroups.${group.key}`), group.key).toBe(true);
      return group.items;
    });
    for (const name of Object.keys(PERMISSIONS)) {
      expect(grouped, name).toContain(name);
      expect(has(`guildAdmin.permissions.${name}.label`), name).toBe(true);
      expect(has(`guildAdmin.permissions.${name}.description`), name).toBe(true);
    }
  });

  it('labels every channel override, for every channel type', () => {
    for (const type of ['text', 'voice', 'list', 'doc']) {
      for (const [, labelKey] of channelPermissionItems(type)) {
        expect(has(`guildAdmin.channelPermissions.items.${labelKey}`), labelKey).toBe(true);
      }
    }
    for (const state of ['allow', 'deny', 'inherit']) {
      expect(has(`guildAdmin.channelPermissions.states.${state}.label`), state).toBe(true);
      expect(has(`guildAdmin.auditLog.overrideStates.${state}`), state).toBe(true);
    }
  });

  it('has a sentence for each kind of channel', () => {
    for (const kind of ['text', 'voice', 'list', 'doc']) {
      for (const key of ['channelCreate', 'channelClone', 'channelDelete']) {
        expect(has(`guildAdmin.auditLog.entries.${key}.${kind}`), `${key}.${kind}`).toBe(true);
      }
      expect(has(`guildAdmin.cloneChannel.hint.${kind}`), kind).toBe(true);
    }
    for (const key of ['messageText', 'messageList', 'messageDoc']) {
      expect(has(`guilds.sidebar.deleteChannel.${key}`), key).toBe(true);
    }
  });

  it('describes every audit log action', () => {
    // Every `case '…'` in auditLog.js, in each variant; a missing sentence fails the test
    // (setupTests.js).
    const source = readFileSync(join(import.meta.dirname, '../utils/auditLog.js'), 'utf8');
    const actions = [...source.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(30);
    const names = { user: () => 'Alice', webhook: (_id, fallback) => fallback };
    const variants = [
      {}, { type: 'voice' }, { type: 'list' }, { type: 'doc' }, { clonedFrom: 'general' },
      { olderThanDays: 30 }, { deleted: 1 },
    ];
    for (const action of [...actions, 'something_new']) {
      for (const details of variants) {
        for (const actor of [{ actor_id: 1 }, { actor_id: null, actor_webhook_id: 9 }]) {
          for (const target of [{ target_type: 'user', target_id: '1' }, { target_type: 'role', target_id: '2' }, { target_type: 'webhook', target_id: '9' }]) {
            const parts = describeAuditEntry({ action, ...actor, ...target, details: { name: 'x', deleted: 2, ...details } }, names);
            expect(parts.length, action).toBeGreaterThan(0);
            entryChanges({ action, details: { changes: { name: ['a', 'b'], hoist: [false, true], archived: [true, false] } } });
          }
        }
      }
    }
  });
});
