import { describe, it, expect } from 'vitest';

const {
  PERMISSIONS: P,
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  guildPermissions,
  channelPermissions,
  highestPosition,
} = require('../permissions.js');

const everyone = { id: 1, position: 0, permissions: DEFAULT_EVERYONE_PERMISSIONS };
const mod = { id: 2, position: 2, permissions: P.MANAGE_MESSAGES | P.KICK_MEMBERS };
const helper = { id: 3, position: 1, permissions: 0 };
const member = (roles = [], isOwner = false) => ({ isOwner, everyone, roles });

describe('permissions', () => {
  it("adds up @everyone's and the member's roles' permissions", () => {
    expect(guildPermissions(member())).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    expect(guildPermissions(member([mod]))).toBe(DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_MESSAGES | P.KICK_MEMBERS);
  });

  it('gives the owner and administrators everything, overrides or not', () => {
    const admin = { id: 9, position: 5, permissions: P.ADMINISTRATOR };
    const lockout = [{ target_type: 'role', target_id: 1, allow: 0, deny: P.VIEW_CHANNEL | P.SEND_MESSAGES }];
    expect(guildPermissions(member([], true))).toBe(ALL_PERMISSIONS);
    expect(guildPermissions(member([admin]))).toBe(ALL_PERMISSIONS);
    expect(channelPermissions(member([admin]), 7, lockout)).toBe(ALL_PERMISSIONS);
    expect(channelPermissions(member([], true), 7, lockout)).toBe(ALL_PERMISSIONS);
  });

  it("applies overrides: @everyone's, then roles' (allow beats deny), then the member's", () => {
    const privateChannel = [
      { target_type: 'role', target_id: 1, allow: 0, deny: P.VIEW_CHANNEL },
      { target_type: 'role', target_id: 2, allow: P.VIEW_CHANNEL, deny: 0 },
      { target_type: 'role', target_id: 3, allow: 0, deny: P.VIEW_CHANNEL },
    ];
    expect(channelPermissions(member(), 7, privateChannel) & P.VIEW_CHANNEL).toBe(0);
    expect(channelPermissions(member([mod]), 7, privateChannel) & P.VIEW_CHANNEL).toBe(P.VIEW_CHANNEL);
    // One of your roles allowing it is enough, even if another denies it.
    expect(channelPermissions(member([mod, helper]), 7, privateChannel) & P.VIEW_CHANNEL).toBe(P.VIEW_CHANNEL);
    expect(channelPermissions(member([helper]), 7, privateChannel) & P.VIEW_CHANNEL).toBe(0);

    // The member's own override comes last.
    const withMember = [...privateChannel, { target_type: 'member', target_id: 7, allow: 0, deny: P.VIEW_CHANNEL }];
    expect(channelPermissions(member([mod]), 7, withMember) & P.VIEW_CHANNEL).toBe(0);
    expect(channelPermissions(member([mod]), 8, withMember) & P.VIEW_CHANNEL).toBe(P.VIEW_CHANNEL);
  });

  it('ranks members by their highest role, the owner above all', () => {
    expect(highestPosition(member())).toBe(0);
    expect(highestPosition(member([helper, mod]))).toBe(2);
    expect(highestPosition(member([], true))).toBe(Infinity);
  });

  it('matches the client copy', async () => {
    const client = await import('../../client/src/utils/permissions.js');
    expect(client.PERMISSIONS).toEqual(P);
    expect(client.DEFAULT_EVERYONE_PERMISSIONS).toBe(DEFAULT_EVERYONE_PERMISSIONS);
  });
});
