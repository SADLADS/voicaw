// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/guildService', () => ({
  setMemberRoles: vi.fn(async () => {}),
  fetchMemberLevel: vi.fn(async () => ({})),
  changeMemberXp: vi.fn(async () => ({})),
}));

import ProfilePopover from './ProfilePopover';
import { GuildMembersContext } from '../contexts';

const anchor = { left: 10, right: 60, top: 10, bottom: 30 };
const roles = [
  { id: 3, name: 'Mods', color: null, position: 2, permissions: 0, is_everyone: 0 },
  { id: 2, name: 'Regulars', color: null, position: 1, permissions: 0, is_everyone: 0 },
  { id: 1, name: '@everyone', color: null, position: 0, permissions: 0, is_everyone: 1 },
];
const members = [
  { id: 1, username: 'owner', joined_at: 1, role_ids: [] },
  { id: 2, username: 'mod', joined_at: 1, role_ids: [3] },
  { id: 4, username: 'newbie', joined_at: 1, role_ids: [2] },
];
// As the Mod, with Manage Roles.
const guildMembers = { guild: { id: 5, owner: 1, roles, my_permissions: 32 }, members, user: { id: 2 } };

describe('ProfilePopover', () => {
  it("shows a guild member the member list's card: roles, and + for those you outrank", () => {
    render(
      <MemoryRouter>
        <GuildMembersContext.Provider value={guildMembers}>
          <ProfilePopover user={{ id: 4, username: 'newbie' }} anchor={anchor} onClose={() => {}} />
        </GuildMembersContext.Provider>
      </MemoryRouter>
    );
    const card = screen.getByRole('dialog', { name: 'Profile of newbie' });
    expect(within(card).getByText('Regulars')).toBeInTheDocument();
    expect(within(card).getByText(/Member since/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Remove Regulars' })).toBeInTheDocument();
  });

  it('shows only the profile outside guilds, and for someone not in the guild', () => {
    const { unmount } = render(<ProfilePopover user={{ id: 4, username: 'newbie' }} anchor={anchor} onClose={() => {}} />);
    let card = screen.getByRole('dialog', { name: 'Profile of newbie' });
    expect(within(card).queryByText(/Member since/)).toBeNull();
    unmount();
    render(
      <GuildMembersContext.Provider value={guildMembers}>
        <ProfilePopover user={{ id: 9, username: 'gone' }} anchor={anchor} onClose={() => {}} />
      </GuildMembersContext.Provider>
    );
    card = screen.getByRole('dialog', { name: 'Profile of gone' });
    expect(within(card).queryByText(/Member since/)).toBeNull();
  });
});
