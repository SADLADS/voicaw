// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('../../services/guildService', () => ({
  leaveGuild: vi.fn(async () => {}),
  createInvite: vi.fn(async () => ({ code: 'abc12345', expires_at: null, max_uses: null })),
}));

import GuildSidebar from './GuildSidebar';
import { LayoutContext } from '../../contexts';
import { leaveGuild } from '../../services/guildService';

const owner = { id: 1, username: 'owner' };
const member = { id: 2, username: 'member' };
const guild = {
  id: 5,
  name: 'Test Guild',
  owner: 1,
  icon_version: 0,
  categories: [{ id: 1, name: 'Text Channels', position: 0 }, { id: 2, name: 'Fun', position: 1 }],
  channels: [
    { id: 10, name: 'general', type: 'text', category_id: 1, position: 0 },
    { id: 11, name: 'memes', type: 'text', category_id: 2, position: 1 },
    { id: 12, name: 'lounge', type: 'voice', category_id: 2, position: 2 },
  ],
};

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderSidebar({ user = owner, unread = [], path = '/guild/5/10' } = {}) {
  const guildList = { unread, removeGuild: vi.fn() };
  render(
    <LayoutContext.Provider value={{ guildList }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/guild/:guildId/:channelId?" element={<><GuildSidebar guild={guild} user={user} /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </LayoutContext.Provider>
  );
  return guildList;
}

const channelRow = (name) => screen.getByRole('link', { name }).closest('li');

beforeEach(() => {
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

  it('opens the invite dialog with a fresh link', async () => {
    renderSidebar({ user: member });
    fireEvent.click(screen.getByRole('button', { name: /Test Guild/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Invite People' }));
    await waitFor(() => expect(screen.getByLabelText(/invite link/)).toHaveValue(`${window.location.origin}/invite/abc12345`));
  });
});
