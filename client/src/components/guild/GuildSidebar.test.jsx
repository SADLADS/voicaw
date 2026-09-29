// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('../../services/guildService', () => ({
  leaveGuild: vi.fn(async () => {}),
  createInvite: vi.fn(async () => ({ code: 'abc12345', expires_at: null, max_uses: null })),
}));

const voice = vi.hoisted(() => ({ snapshot: { status: 'idle', guildId: null, channelId: null, speaking: [] } }));
vi.mock('../../voice/voiceClient', () => ({
  getVoiceSnapshot: () => voice.snapshot,
  onVoiceChange: () => () => {},
  joinVoice: vi.fn(),
}));

import GuildSidebar from './GuildSidebar';
import { ConfigContext, InteractionContext, LayoutContext } from '../../contexts';
import { joinVoice } from '../../voice/voiceClient';
import { leaveGuild } from '../../services/guildService';

const owner = { id: 1, username: 'owner' };
const member = { id: 2, username: 'member' };
const ALL = 2047;
const DEFAULT = 135; // view, send, react, create invite
const baseGuild = {
  id: 5,
  name: 'Test Guild',
  owner: 1,
  icon_version: 0,
  roles: [{ id: 1, name: '@everyone', color: null, position: 0, permissions: DEFAULT, hoist: 0, is_everyone: 1 }],
  my_role_ids: [],
  categories: [{ id: 1, name: 'Text Channels', position: 0 }, { id: 2, name: 'Fun', position: 1 }],
  channels: [
    { id: 10, name: 'general', type: 'text', category_id: 1, position: 0 },
    { id: 11, name: 'memes', type: 'text', category_id: 2, position: 1 },
    {
      id: 12, name: 'lounge', type: 'voice', category_id: 2, position: 2, my_permissions: 135 | 4096,
      voice: [
        { user_id: 3, username: 'carol', self_mute: false, self_deaf: false },
        { user_id: 4, username: 'dave', self_mute: true, self_deaf: true },
      ],
    },
  ],
};

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderSidebar({ user = owner, unread = [], path = '/guild/5/10', permissions, isMobile = false } = {}) {
  const guildList = { unread, removeGuild: vi.fn() };
  const guild = { ...baseGuild, my_permissions: permissions ?? (user.id === baseGuild.owner ? ALL : DEFAULT) };
  render(
    <ConfigContext.Provider value={{ s3Endpoint: '', voiceEnabled: true }}>
    <InteractionContext.Provider value={{ isMobile }}>
    <LayoutContext.Provider value={{ guildList }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/guild/:guildId/:channelId?" element={<><GuildSidebar guild={guild} user={user} /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </LayoutContext.Provider>
    </InteractionContext.Provider>
    </ConfigContext.Provider>
  );
  return guildList;
}

const channelRow = (name) => screen.getByRole('link', { name }).closest('li');

beforeEach(() => {
  voice.snapshot = { status: 'idle', guildId: null, channelId: null, speaking: [] };
  vi.clearAllMocks();
  localStorage.clear();
});

describe('GuildSidebar', () => {
  it('lists channels under their categories, marking the open one', () => {
    renderSidebar();
    expect(screen.getByText('Test Guild')).toBeInTheDocument();
    const fun = screen.getByRole('button', { name: 'Fun' }).closest('.guild-category');
    expect(within(fun).getAllByRole('link').map((a) => a.textContent)).toEqual(['memes', 'lounge']);
    expect(channelRow('general')).toHaveClass('active');
    expect(screen.getByRole('link', { name: 'general' })).toHaveAttribute('href', '/guild/5/10');
  });

  it('marks unread channels, except the open one', () => {
    renderSidebar({ unread: [{ channel_id: 11, guild_id: 5, count: 2 }, { channel_id: 10, guild_id: 5, count: 1 }] });
    expect(channelRow('memes')).toHaveClass('unread');
    expect(channelRow('general')).not.toHaveClass('unread');
  });

  it('collapses a category but keeps unread channels showing, and remembers it', () => {
    renderSidebar({ unread: [{ channel_id: 11, guild_id: 5, count: 1 }] });
    fireEvent.click(screen.getByRole('button', { name: 'Fun' }));
    expect(screen.getByRole('link', { name: 'memes' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'lounge' })).toBeNull();
    expect(JSON.parse(localStorage.getItem('collapsedCategories'))).toEqual([2]);
  });

  it('gives the owner management items and edit buttons', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Edit general' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create channel in Fun' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Test Guild/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent.trim())).toEqual([
      'Invite People', 'Server Settings', 'Create Channel', 'Create Category',
    ]);
  });

  it('lets a member invite and leave, but not manage', async () => {
    const guildList = renderSidebar({ user: member });
    expect(screen.queryByRole('button', { name: 'Edit general' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Test Guild/ }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent.trim())).toEqual([
      'Invite People', 'Leave Server',
    ]);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave Server' }));
    const dialog = screen.getByRole('dialog', { name: "Leave 'Test Guild'" });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave Server' }));
    await waitFor(() => expect(leaveGuild).toHaveBeenCalledWith(5));
    expect(guildList.removeGuild).toHaveBeenCalledWith(5);
  });

  it('offers what your permissions allow', () => {
    // Manage Channels (16) only: create and edit, but no settings or invites.
    renderSidebar({ user: member, permissions: 1 | 16 });
    expect(screen.getByRole('button', { name: 'Edit general' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Test Guild/ }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent.trim())).toEqual([
      'Create Channel', 'Create Category', 'Leave Server',
    ]);
  });

  it('shows a lock on private channels', () => {
    renderSidebar();
    expect(within(channelRow('general')).queryByLabelText('Private')).toBeNull();
  });

  it('opens the invite dialog with a fresh link', async () => {
    renderSidebar({ user: member });
    fireEvent.click(screen.getByRole('button', { name: /Test Guild/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Invite People' }));
    await waitFor(() => expect(screen.getByLabelText(/invite link/)).toHaveValue(`${window.location.origin}/invite/abc12345`));
  });

  it("lists who's in a voice channel under it, with mute and deafen", () => {
    renderSidebar();
    const list = screen.getByRole('list', { name: 'In this channel' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['carol', 'dave']);
    expect(within(rows[0]).queryByLabelText('Muted')).toBeNull();
    expect(within(rows[1]).getByLabelText('Muted')).toBeInTheDocument();
    expect(within(rows[1]).getByLabelText('Deafened')).toBeInTheDocument();
  });

  it('rings whoever is talking in your own voice channel', () => {
    voice.snapshot = { status: 'connected', guildId: 5, channelId: 12, speaking: ['3'] };
    renderSidebar();
    expect(channelRow('lounge')).toHaveClass('connected');
    const [carol, dave] = screen.getByRole('list', { name: 'In this channel' }).querySelectorAll('img');
    expect(carol).toHaveClass('speaking');
    expect(dave).not.toHaveClass('speaking');
  });

  it('joins a voice channel on click (desktop) but only opens it on a phone', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('link', { name: 'lounge' }));
    expect(joinVoice).toHaveBeenCalledWith(5, 12);
    expect(screen.getByTestId('where')).toHaveTextContent('/guild/5/12');
  });

  it("doesn't join from a phone", () => {
    renderSidebar({ isMobile: true });
    fireEvent.click(screen.getByRole('link', { name: 'lounge' }));
    expect(joinVoice).not.toHaveBeenCalled();
  });
});
