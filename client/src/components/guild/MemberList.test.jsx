// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/guildService', () => ({
  setMemberRoles: vi.fn(async () => {}),
  kickMember: vi.fn(async () => {}),
  banMember: vi.fn(async () => {}),
  transferGuild: vi.fn(async () => {}),
}));

import MemberList from './MemberList';
import { setMemberRoles } from '../../services/guildService';

const roles = [
  { id: 4, name: 'Admins', color: 0xe67e22, position: 3, hoist: 1, permissions: 0, is_everyone: 0 },
  { id: 3, name: 'Mods', color: 0xe91e63, position: 2, hoist: 0, permissions: 0, is_everyone: 0 },
  { id: 2, name: 'Regulars', color: null, position: 1, hoist: 0, permissions: 0, is_everyone: 0 },
  { id: 1, name: '@everyone', color: null, position: 0, hoist: 0, permissions: 135, is_everyone: 1 },
];
const members = [
  { id: 1, username: 'owner', joined_at: 1, role_ids: [], status: 'online' },
  { id: 2, username: 'mod', joined_at: 1, role_ids: [3], status: 'online' },
  { id: 3, username: 'admin', joined_at: 1, role_ids: [4], status: 'online' },
  { id: 4, username: 'newbie', joined_at: 1, role_ids: [], status: 'offline' },
];

// Manage Roles (32) + Kick (256), as the member with id 2 (a Mod).
function renderList(permissions = 32 | 256, userId = 2) {
  const guild = { id: 5, name: 'G', owner: 1, roles, my_permissions: permissions, my_role_ids: [3] };
  render(<MemoryRouter><MemberList guild={guild} members={members} user={{ id: userId }} /></MemoryRouter>);
}

beforeEach(() => vi.clearAllMocks());

describe('MemberList', () => {
  it('groups and colours members', () => {
    renderList();
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Admins — 1', 'Online — 2', 'Offline — 1']);
    expect(screen.getByText('mod')).toHaveStyle({ color: '#e91e63' });
  });

  it('lets you give roles below yours to people below you, and kick them', async () => {
    renderList();
    fireEvent.click(screen.getByText('newbie'));
    const card = screen.getByRole('dialog', { name: 'newbie' });
    expect(within(card).getByRole('button', { name: 'Kick' })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Add role' }));
    const picker = within(card).getByRole('list', { name: 'Roles to add' });
    // Only Regulars is below Mods.
    expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(['Regulars']);
    fireEvent.click(within(picker).getByRole('button', { name: 'Regulars' }));
    await waitFor(() => expect(setMemberRoles).toHaveBeenCalledWith(5, 4, [2]));
  });

  it("doesn't offer anything over people as high or higher", () => {
    renderList();
    fireEvent.click(screen.getByText('admin'));
    const card = screen.getByRole('dialog', { name: 'admin' });
    expect(within(card).queryByRole('button', { name: 'Kick' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Add role' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Remove Admins' })).toBeNull();
  });

  it("tags bots, offers no Message for them, and leaves a bot's own role alone", () => {
    const botRole = { id: 5, name: 'Helper', color: null, position: 1, hoist: 0, permissions: 0, is_everyone: 0, bot_id: 6 };
    const guild = { id: 5, name: 'G', owner: 1, roles: [...roles.slice(0, 2), botRole, ...roles.slice(2)], my_permissions: 32, my_role_ids: [3] };
    const bot = { id: 6, username: 'helper#0420', display_name: 'Helper', bot: 1, joined_at: 1, role_ids: [5], status: 'online' };
    render(<MemoryRouter><MemberList guild={guild} members={[...members, bot]} user={{ id: 2 }} /></MemoryRouter>);
    expect(screen.getByText('BOT')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Helper', { selector: '.member-name' }));
    const card = screen.getByRole('dialog', { name: 'Helper' });
    expect(within(card).queryByRole('button', { name: 'Message' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Remove Helper' })).toBeNull();
    // Nor offered to anyone else.
    fireEvent.click(screen.getByText('newbie'));
    const other = screen.getByRole('dialog', { name: 'newbie' });
    fireEvent.click(within(other).getByRole('button', { name: 'Add role' }));
    expect(within(within(other).getByRole('list', { name: 'Roles to add' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Regulars']);
  });

  it('shows no management without the permissions', () => {
    renderList(0);
    fireEvent.click(screen.getByText('newbie'));
    const card = screen.getByRole('dialog', { name: 'newbie' });
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['Message']);
  });
});
