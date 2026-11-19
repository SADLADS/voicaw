// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('../../services/guildService', () => ({
  deleteGuild: vi.fn(async () => {}),
  fetchBans: vi.fn(async () => []),
  fetchInvites: vi.fn(async () => []),
  fetchVanityInvite: vi.fn(async () => ({ code: null, uses: 0 })),
  revokeInvite: vi.fn(async () => {}),
  setVanityInvite: vi.fn(async () => {}),
  unbanMember: vi.fn(async () => {}),
  updateGuild: vi.fn(async () => {}),
  uploadGuildIcon: vi.fn(async () => {}),
  setJoinLog: vi.fn(async () => {}),
}));
// The pages themselves have their own tests and requests: stand-ins here.
vi.mock('./RolesSettings', () => ({ default: () => <p>roles page</p> }));
vi.mock('./EmojiSettings', () => ({ default: () => <p>emoji page</p> }));
vi.mock('./SoundboardSettings', () => ({ default: () => <p>soundboard page</p> }));
vi.mock('./LevelSettings', () => ({ default: () => <p>levels page</p> }));
vi.mock('./MediaServerSettings', () => ({ default: () => <p>media page</p> }));
vi.mock('./GuildImport', () => ({ default: () => <p>import page</p> }));

import GuildSettingsDialog from './GuildSettingsDialog';
import { ConfigContext, LayoutContext } from '../../contexts';
import { PERMISSIONS } from '../../utils/permissions';

const ALL = PERMISSIONS.MANAGE_GUILD | PERMISSIONS.MANAGE_ROLES | PERMISSIONS.MANAGE_EMOJIS
  | PERMISSIONS.BAN_MEMBERS | PERMISSIONS.ADMINISTRATOR;

function renderDialog({ permissions = ALL, owner = 1, config = {} } = {}) {
  const guild = { id: 5, name: 'Night Owls', owner, my_permissions: permissions, levels: { enabled: false }, channels: [] };
  return render(
    <ConfigContext.Provider value={config}>
      <LayoutContext.Provider value={{ guildList: { removeGuild: vi.fn() } }}>
        <GuildSettingsDialog guild={guild} user={{ id: 1 }} onClose={() => {}} />
      </LayoutContext.Provider>
    </ConfigContext.Provider>
  );
}

const nav = () => screen.getByRole('navigation');
const items = () => within(nav()).getAllByRole('button').map((b) => b.textContent);
const groups = () => [...nav().querySelectorAll('.settings-nav-category')].map((g) => g.textContent);

afterEach(cleanup);

describe('GuildSettingsDialog', () => {
  it('lists every page, grouped, for the owner', () => {
    renderDialog();
    expect(groups()).toEqual(['Guild', 'Emoji and sounds', 'Features', 'Moderation']);
    expect(items()).toEqual(['Overview', 'Roles', 'Invites', 'Emoji', 'Soundboard', 'Levels', 'Watch Together', 'Bans', 'Import', 'Delete guild']);
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy();
    expect(nav().querySelector('.guild-settings-nav-name').textContent).toBe('Night Owls');
  });

  it('opens a page from the list and marks it current', () => {
    renderDialog();
    fireEvent.click(within(nav()).getByRole('button', { name: 'Roles' }));
    expect(screen.getByText('roles page')).toBeTruthy();
    expect(within(nav()).getByRole('button', { name: 'Roles' }).getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('.guild-settings-layout').classList.contains('page-open')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(document.querySelector('.guild-settings-layout').classList.contains('page-open')).toBe(false);
  });

  it('keeps Delete guild for the owner, on its own page', () => {
    renderDialog({ owner: 2 });
    expect(items()).not.toContain('Delete guild');
    cleanup();
    renderDialog();
    expect(screen.queryByLabelText('Guild name to confirm')).toBeNull(); // not on Overview
    fireEvent.click(within(nav()).getByRole('button', { name: 'Delete guild' }));
    const confirm = screen.getByLabelText('Guild name to confirm');
    const button = screen.getAllByRole('button', { name: 'Delete guild' }).find((b) => !nav().contains(b));
    expect(button.disabled).toBe(true);
    fireEvent.change(confirm, { target: { value: 'Night Owls' } });
    expect(button.disabled).toBe(false);
  });

  it('hides groups with nothing left and starts on the first page there is', () => {
    renderDialog({ permissions: PERMISSIONS.MANAGE_EMOJIS | PERMISSIONS.BAN_MEMBERS, owner: 2 });
    expect(groups()).toEqual(['Emoji and sounds', 'Moderation']);
    expect(items()).toEqual(['Emoji', 'Soundboard', 'Bans']);
    expect(screen.getByText('emoji page')).toBeTruthy();
  });

  it('leaves Import out when the server turns imports off', () => {
    renderDialog({ config: { historyImports: false } });
    expect(items()).not.toContain('Import');
    expect(items()).toContain('Delete guild');
  });

  it('says so when there is nothing you may change', () => {
    renderDialog({ permissions: 0, owner: 2 });
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByText("You don't have permission to change anything here.")).toBeTruthy();
  });
});
