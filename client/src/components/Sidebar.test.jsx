// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/guildService', () => ({
  leaveGuild: vi.fn(async () => {}),
  markChannelReadToLatest: vi.fn(async () => {}),
  setGuildNotifications: vi.fn(async () => {}),
  createInvite: vi.fn(async () => ({ code: 'abc12345', expires_at: null, max_uses: null })),
}));

import Sidebar from './Sidebar';
import { ConfigContext, InteractionContext, LayoutContext } from '../contexts';
import { leaveGuild, markChannelReadToLatest, setGuildNotifications } from '../services/guildService';

const ALL = 2 ** 31 - 1;
const DEFAULT = 135; // view, send, react, create invite
const guilds = [{ id: 5, name: 'Alpha', owner: 1, icon_version: 0 }, { id: 6, name: 'Beta', owner: 2, icon_version: 0 }];
const layout = (id, permissions, extra = {}) => ({
  ...guilds.find((g) => g.id === id), my_permissions: permissions, my_notify_level: 'mentions', roles: [], categories: [], channels: [], ...extra,
});

function renderRail({ layouts = { 5: layout(5, ALL), 6: layout(6, DEFAULT) }, unread = [] } = {}) {
  const guildList = {
    guilds,
    layouts,
    unread,
    loadGuild: vi.fn(async () => {}),
    clearUnread: vi.fn(),
    removeGuild: vi.fn(),
  };
  render(
    <ConfigContext.Provider value={{ s3Endpoint: '' }}>
      <InteractionContext.Provider value={{ isMobile: false }}>
        <LayoutContext.Provider value={{ guildList }}>
          <MemoryRouter initialEntries={['/dm']}>
            <Sidebar user={{ id: 1, username: 'owner' }} guilds={guilds} />
          </MemoryRouter>
        </LayoutContext.Provider>
      </InteractionContext.Provider>
    </ConfigContext.Provider>
  );
  return guildList;
}

const items = (menu) => [...menu.querySelectorAll('[role^="menuitem"]')].map((b) => b.firstChild.firstChild.textContent);
const icon = (name) => screen.getByRole('link', { name });

beforeEach(() => vi.clearAllMocks());

describe('the guild rail menu', () => {
  it("offers the owner's guild options (no Leave), and a member's (no settings)", () => {
    renderRail({ unread: [{ guild_id: 5, channel_id: 10, count: 2, mentions: 0 }] });
    fireEvent.contextMenu(icon('Alpha'));
    expect(items(screen.getByRole('menu', { name: 'Alpha' }))).toEqual([
      'Mark As Read', 'Invite People', 'Notification Settings', 'Guild Settings', 'Audit Log', 'Copy Link',
    ]);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.contextMenu(icon('Beta'));
    expect(items(screen.getByRole('menu', { name: 'Beta' }))).toEqual(['Invite People', 'Notification Settings', 'Copy Link', 'Leave Guild']);
  });

  it('marks a guild read and sets its notification level', async () => {
    const guildList = renderRail({ unread: [{ guild_id: 5, channel_id: 10, count: 2, mentions: 0 }, { guild_id: 5, channel_id: 11, count: 0, mentions: 1 }] });
    fireEvent.contextMenu(icon('Alpha'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark As Read' }));
    await waitFor(() => expect(markChannelReadToLatest).toHaveBeenCalledTimes(2));
    expect(guildList.clearUnread).toHaveBeenCalledWith(10);
    expect(guildList.clearUnread).toHaveBeenCalledWith(11);

    fireEvent.contextMenu(icon('Alpha'));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /^Notification Settings/ }));
    const levels = screen.getByRole('menu', { name: 'Notification Settings' });
    expect(within(levels).getByRole('menuitemradio', { name: 'Only @mentions' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(levels).getByRole('menuitemradio', { name: 'Nothing' }));
    await waitFor(() => expect(setGuildNotifications).toHaveBeenCalledWith(5, 'none'));
    expect(guildList.loadGuild).toHaveBeenCalledWith(5);
  });

  it('leaves a guild after asking, and loads a layout not opened yet', async () => {
    const guildList = renderRail({ layouts: { 6: layout(6, DEFAULT) } });
    fireEvent.contextMenu(icon('Alpha'));
    expect(guildList.loadGuild).toHaveBeenCalledWith(5);
    fireEvent.contextMenu(icon('Beta'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave Guild' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Leave Guild' }));
    await waitFor(() => expect(leaveGuild).toHaveBeenCalledWith(6));
    expect(guildList.removeGuild).toHaveBeenCalledWith(6);
  });
});
