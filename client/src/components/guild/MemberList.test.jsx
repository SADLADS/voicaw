// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/guildService', () => ({
  setMemberRoles: vi.fn(async () => {}),
  kickMember: vi.fn(async () => {}),
  banMember: vi.fn(async () => {}),
  transferGuild: vi.fn(async () => {}),
  fetchMemberLevel: vi.fn(async (guildId, userId) => ({ user_id: userId, xp: 1250, level: 12, rank: 3 })),
  changeMemberXp: vi.fn(async () => ({})),
}));

import MemberList from './MemberList';
import { changeMemberXp, setMemberRoles } from '../../services/guildService';

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

  it('lets you give roles below yours to people below you', async () => {
    renderList();
    fireEvent.click(screen.getByText('newbie'));
    const card = screen.getByRole('dialog', { name: 'newbie' });
    fireEvent.click(within(card).getByRole('button', { name: 'Add role' }));
    const picker = within(card).getByRole('list', { name: 'Roles to add' });
    // Only Regulars is below Mods.
    expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(['Regulars']);
    fireEvent.click(within(picker).getByRole('button', { name: 'Regulars' }));
    await waitFor(() => expect(setMemberRoles).toHaveBeenCalledWith(5, 4, [2]));
  });

  it('searches the roles to add: focused when + opens it, Enter adds the first match, Escape closes', async () => {
    renderList(32, 3); // as the Admin: Mods and Regulars are below
    fireEvent.click(screen.getByText('newbie'));
    const card = screen.getByRole('dialog', { name: 'newbie' });
    fireEvent.click(within(card).getByRole('button', { name: 'Add role' }));
    const search = within(card).getByRole('searchbox', { name: 'Search roles' });
    expect(search).toHaveFocus();
    const listed = () => within(within(card).getByRole('list', { name: 'Roles to add' })).queryAllByRole('button').map((b) => b.textContent);
    expect(listed()).toEqual(['Mods', 'Regulars']);
    fireEvent.change(search, { target: { value: 'REG' } });
    expect(listed()).toEqual(['Regulars']);
    fireEvent.change(search, { target: { value: 'nothing' } });
    expect(listed()).toEqual([]);
    expect(within(card).getByText('No roles match.')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'mo' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(setMemberRoles).toHaveBeenCalledWith(5, 4, [3]));
    expect(within(card).queryByRole('searchbox')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Add role' }));
    expect(within(card).getByRole('searchbox', { name: 'Search roles' })).toHaveValue('');
    fireEvent.keyDown(within(card).getByRole('searchbox'), { key: 'Escape' });
    expect(within(card).queryByRole('searchbox')).toBeNull();
  });

  it("doesn't offer anything over people as high or higher", () => {
    renderList();
    fireEvent.click(screen.getByText('admin'));
    const card = screen.getByRole('dialog', { name: 'admin' });
    expect(within(card).queryByRole('button', { name: 'Kick' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Add role' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Remove Admins' })).toBeNull();
  });

  it("tags bots and leaves a bot's own role alone", () => {
    const botRole = { id: 5, name: 'Helper', color: null, position: 1, hoist: 0, permissions: 0, is_everyone: 0, bot_id: 6 };
    const guild = { id: 5, name: 'G', owner: 1, roles: [...roles.slice(0, 2), botRole, ...roles.slice(2)], my_permissions: 32, my_role_ids: [3] };
    const bot = { id: 6, username: 'helper#0420', display_name: 'Helper', bot: 1, joined_at: 1, role_ids: [5], status: 'online' };
    render(<MemoryRouter><MemberList guild={guild} members={[...members, bot]} user={{ id: 2 }} /></MemoryRouter>);
    expect(screen.getByText('BOT')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Helper', { selector: '.member-name' }));
    const card = screen.getByRole('dialog', { name: 'Helper' });
    expect(within(card).queryByRole('button', { name: 'Remove Helper' })).toBeNull();
    // Nor offered to anyone else.
    fireEvent.click(screen.getByText('newbie'));
    const other = screen.getByRole('dialog', { name: 'newbie' });
    fireEvent.click(within(other).getByRole('button', { name: 'Add role' }));
    expect(within(within(other).getByRole('list', { name: 'Roles to add' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Regulars']);
  });

  it("offers the channel's bots' user commands as Apps on the card", async () => {
    const onRunUserApp = vi.fn(async () => {});
    const apps = [{ id: 11, type: 2, name: 'Wave', bot: { id: 9, name: 'Waver' } }];
    const guild = { id: 5, name: 'G', owner: 1, roles, my_permissions: 0, my_role_ids: [] };
    render(<MemoryRouter><MemberList guild={guild} members={members} user={{ id: 2 }} userApps={apps} onRunUserApp={onRunUserApp} /></MemoryRouter>);
    fireEvent.click(screen.getByText('newbie'));
    const card = screen.getByRole('dialog', { name: 'newbie' });
    fireEvent.click(within(within(card).getByRole('group', { name: 'Apps' })).getByRole('button', { name: /Wave/ }));
    await waitFor(() => expect(onRunUserApp).toHaveBeenCalledWith(apps[0], 4));
  });

  it('shows no buttons without the permissions (Message, Kick, Block... are in the right-click menu)', () => {
    renderList(32 | 256 | 4);
    fireEvent.click(screen.getByText('newbie'));
    const withPermissions = screen.getByRole('dialog', { name: 'newbie' });
    expect(within(withPermissions).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Add role']);
    cleanup();
    renderList(0);
    fireEvent.click(screen.getByText('newbie'));
    expect(within(screen.getByRole('dialog', { name: 'newbie' })).queryAllByRole('button')).toEqual([]);
  });

  describe('levels', () => {
    const levels = {
      enabled: true, xpPerLevel: 100, xpName: '', levelName: '', levelShort: '', showInMemberList: true, messageCooldown: 60, sources: {},
    };
    const ranked = members.map((m) => ({ ...m, xp: { 1: 0, 2: 1250, 3: 150000, 4: 50 }[m.id] }));
    const renderLevels = (settings = levels, permissions = 0) => {
      const guild = { id: 5, name: 'G', owner: 1, roles, my_permissions: permissions, my_role_ids: [3], levels: settings };
      render(<MemoryRouter><MemberList guild={guild} members={ranked} user={{ id: 2 }} /></MemoryRouter>);
    };

    it('shows levels beside pictures, not level 0, in the guild\'s words', () => {
      renderLevels({ ...levels, levelShort: 'rk' });
      expect(screen.getByText('12 rk')).toBeInTheDocument();
      expect(screen.getByText('1.5k rk')).toBeInTheDocument();
      expect(screen.queryByText(/^0 rk/)).toBeNull();
    });

    it('hides them when the guild turns them off, or off the member list', () => {
      renderLevels({ ...levels, showInMemberList: false });
      expect(screen.queryByText('12 lvl')).toBeNull();
      cleanup();
      renderLevels({ ...levels, enabled: false });
      expect(screen.queryByText('12 lvl')).toBeNull();
      fireEvent.click(screen.getByText('mod'));
      expect(screen.queryByText(/Level 12/)).toBeNull();
    });

    it('shows the level, rank and progress on the card, and lets Manage Levels change it', async () => {
      renderLevels(levels, 1 << 29);
      fireEvent.click(screen.getByText('mod'));
      const card = screen.getByRole('dialog', { name: 'mod' });
      expect(within(card).getByText('Level 12')).toBeInTheDocument();
      expect(await within(card).findByText('#3')).toBeInTheDocument();
      expect(within(card).getByText('50 / 100 XP')).toBeInTheDocument();
      fireEvent.click(within(card).getByRole('button', { name: 'Change' }));
      fireEvent.change(within(card).getByRole('textbox', { name: 'Amount' }), { target: { value: '20' } });
      fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(changeMemberXp).toHaveBeenCalledWith(5, 2, { level: 20 }));
    });

    it('never mentions XP when one XP is one level', async () => {
      renderLevels({ ...levels, xpPerLevel: 1 }, 1 << 29);
      fireEvent.click(screen.getByText('mod'));
      const card = screen.getByRole('dialog', { name: 'mod' });
      expect(await within(card).findByText('#3')).toBeInTheDocument();
      expect(within(card).getByText('Level 1,250')).toBeInTheDocument();
      expect(within(card).queryByText(/XP/)).toBeNull();
      fireEvent.click(within(card).getByRole('button', { name: 'Change' }));
      expect(within(card).queryByRole('option', { name: 'XP' })).toBeNull();
    });
  });
});
