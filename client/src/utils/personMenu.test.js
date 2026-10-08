import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({ default: { put: vi.fn(), delete: vi.fn(), get: vi.fn(), post: vi.fn() } }));

import { personMenuItems, setPersonMenuGuild, setPersonMessenger } from './personMenu';
import { applyFriends } from './friends';
import { applyBlocked } from './blocks';
import { clearProfiles, mergeProfiles } from './profiles';
import { closeSafetyDialog, getSafetyDialog } from './safetyDialogs';
import api from './api';

const roles = [
  { id: 3, name: 'Mods', position: 2, is_everyone: 0 },
  { id: 2, name: 'Regulars', position: 1, is_everyone: 0 },
  { id: 1, name: '@everyone', position: 0, is_everyone: 1 },
];
const members = [
  { id: 1, role_ids: [] }, // the owner
  { id: 2, role_ids: [3] }, // a Mod
  { id: 4, role_ids: [] },
  { id: 6, role_ids: [], bot: 1 },
];
const guild = (permissions, owner = 1) => ({ id: 5, name: 'G', owner, roles, my_permissions: permissions });
// What the menu reads, separators as '-'.
const labels = (items) => items.map((item) => (item.separator ? '-' : item.label));
const find = (items, label) => items.find((item) => item.label === label);

beforeEach(() => {
  vi.clearAllMocks();
  clearProfiles();
  mergeProfiles([{ id: 4, username: 'newbie' }, { id: 6, username: 'helper', bot: 1 }]);
  applyFriends({ friends: [], incoming: [], outgoing: [] });
  applyBlocked([]);
  setPersonMenuGuild(null);
  setPersonMessenger(vi.fn());
  closeSafetyDialog();
});

describe('personMenuItems', () => {
  it('outside a guild: Message, Add Friend, Block, Report, Copy User ID', () => {
    expect(labels(personMenuItems(4, 'newbie', 2))).toEqual(['Message', 'Add Friend', '-', 'Block', 'Report', '-', 'Copy User ID']);
  });

  it('only Copy User ID on yourself', () => {
    setPersonMenuGuild({ guild: guild(256 | 512), members });
    expect(labels(personMenuItems(2, 'mod', 2))).toEqual(['Copy User ID']);
  });

  it('in a guild, Kick and Ban over people you outrank, with the permissions; Make Owner for the owner', () => {
    setPersonMenuGuild({ guild: guild(256 | 512), members });
    expect(labels(personMenuItems(4, 'newbie', 2))).toEqual(['Message', 'Add Friend', '-', 'Kick', 'Ban', '-', 'Block', 'Report', '-', 'Copy User ID']);
    // Not over the owner, nor without the permission.
    expect(labels(personMenuItems(1, 'owner', 2))).not.toContain('Kick');
    setPersonMenuGuild({ guild: guild(256), members });
    expect(labels(personMenuItems(4, 'newbie', 2))).not.toContain('Ban');
    // The owner: Make Owner (not to a bot).
    setPersonMenuGuild({ guild: guild(0), members });
    expect(labels(personMenuItems(4, 'newbie', 1))).toContain('Make Owner');
    expect(labels(personMenuItems(6, 'helper', 1))).not.toContain('Make Owner');
    // Someone who isn't a member: nothing of the guild's.
    expect(labels(personMenuItems(9, 'gone', 1))).toEqual(['Message', 'Add Friend', '-', 'Block', 'Report', '-', 'Copy User ID']);
  });

  it('asks before kicking, banning, making owner or unfriending (SafetyDialogs)', () => {
    setPersonMenuGuild({ guild: guild(256 | 512), members });
    find(personMenuItems(4, 'newbie', 2), 'Kick').onSelect();
    expect(getSafetyDialog()).toMatchObject({ kind: 'kick', userId: 4, name: 'newbie', guild: { id: 5 } });
    find(personMenuItems(4, 'newbie', 2), 'Ban').onSelect();
    expect(getSafetyDialog()).toMatchObject({ kind: 'ban', userId: 4 });
    applyFriends({ friends: [{ id: 4 }], incoming: [], outgoing: [] });
    find(personMenuItems(4, 'newbie', 2), 'Remove Friend').onSelect();
    expect(getSafetyDialog()).toMatchObject({ kind: 'unfriend', userId: 4 });
    setPersonMenuGuild({ guild: guild(0), members });
    find(personMenuItems(4, 'newbie', 1), 'Make Owner').onSelect();
    expect(getSafetyDialog()).toMatchObject({ kind: 'transfer', userId: 4 });
  });

  it('the friend item follows the friendship; none for bots or blocked people', async () => {
    api.put.mockResolvedValue({ data: { friends: [], incoming: [], outgoing: [], result: 'requested' } });
    api.delete.mockResolvedValue({ data: { friends: [], incoming: [], outgoing: [], result: 'removed' } });
    await find(personMenuItems(4, 'newbie', 2), 'Add Friend').onSelect();
    expect(api.put).toHaveBeenCalledWith('/friends/4');
    applyFriends({ friends: [], incoming: [{ id: 4 }], outgoing: [] });
    expect(labels(personMenuItems(4, 'newbie', 2))).toContain('Accept Friend Request');
    applyFriends({ friends: [], incoming: [], outgoing: [{ id: 4 }] });
    await find(personMenuItems(4, 'newbie', 2), 'Cancel Friend Request').onSelect();
    expect(api.delete).toHaveBeenCalledWith('/friends/4');
    expect(labels(personMenuItems(6, 'helper', 2))).toEqual(['Message', '-', 'Block', 'Report', '-', 'Copy User ID']);
    applyBlocked([4]);
    expect(labels(personMenuItems(4, 'newbie', 2))).toEqual(['Message', '-', 'Unblock', 'Report', '-', 'Copy User ID']);
  });

  it('Message opens the conversation (Layout says how)', () => {
    const messenger = vi.fn();
    setPersonMessenger(messenger);
    find(personMenuItems(4, 'newbie', 2), 'Message').onSelect();
    expect(messenger).toHaveBeenCalledWith(4);
    setPersonMessenger(null);
    expect(labels(personMenuItems(4, 'newbie', 2))).not.toContain('Message');
  });
});
