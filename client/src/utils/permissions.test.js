import { describe, it, expect } from 'vitest';
import { colorToHex, hexToColor, memberColor, memberRank, memberRoles } from './permissions';
import { groupMembers } from './guildDisplay';

// Highest first, as the server sends them.
const roles = [
  { id: 4, name: 'Admins', color: null, position: 3, hoist: 1, is_everyone: 0 },
  { id: 3, name: 'Mods', color: 0xe91e63, position: 2, hoist: 1, is_everyone: 0 },
  { id: 2, name: 'Blue', color: 0x3498db, position: 1, hoist: 0, is_everyone: 0 },
  { id: 1, name: '@everyone', color: null, position: 0, hoist: 0, is_everyone: 1 },
];

describe('role display', () => {
  it("uses the highest role's colour, skipping roles without one", () => {
    expect(memberColor(roles, [2, 3])).toBe('#e91e63');
    expect(memberColor(roles, [2, 4])).toBe('#3498db');
    expect(memberColor(roles, [4])).toBeNull();
    expect(memberColor(roles, [])).toBeNull();
    expect(memberRoles(roles, [2, 4]).map((r) => r.name)).toEqual(['Admins', 'Blue']);
  });

  it('ranks by the highest role, the owner above all', () => {
    const guild = { owner: 9, roles };
    expect(memberRank(guild, 5, [2, 3])).toBe(2);
    expect(memberRank(guild, 5, [])).toBe(0);
    expect(memberRank(guild, 9, [])).toBe(Infinity);
  });

  it('converts colours', () => {
    expect(colorToHex(0x00ff0a)).toBe('#00ff0a');
    expect(hexToColor('#e91e63')).toBe(0xe91e63);
  });

  it('groups online members under their highest hoisted role, offline apart', () => {
    const members = [
      { id: 1, username: 'zed', status: 'online', role_ids: [3, 4] },
      { id: 2, username: 'amy', status: 'mobile', role_ids: [3] },
      { id: 3, username: 'bo', status: 'idle', role_ids: [2] },
      { id: 4, username: 'cy', status: 'offline', role_ids: [4] },
    ];
    expect(groupMembers(members, roles).map((g) => [g.title, g.members.map((m) => m.username)])).toEqual([
      ['Admins', ['zed']],
      ['Mods', ['amy']],
      ['Online', ['bo']],
      ['Offline', ['cy']],
    ]);
  });
});
