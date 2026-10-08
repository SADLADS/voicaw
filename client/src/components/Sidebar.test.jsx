// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../services/guildService', () => ({
  leaveGuild: vi.fn(async () => {}),
  markChannelReadToLatest: vi.fn(async () => {}),
  setGuildNotifications: vi.fn(async () => {}),
  createInvite: vi.fn(async () => ({ code: 'abc12345', expires_at: null, max_uses: null })),
}));

// This device's voice connection.
let myVoice = { status: 'idle', guildId: null };
vi.mock('../hooks/useVoice', () => ({ useVoice: () => myVoice }));

import Sidebar from './Sidebar';
import { ConfigContext, InteractionContext, LayoutContext } from '../contexts';
import { leaveGuild, markChannelReadToLatest, setGuildNotifications } from '../services/guildService';
import { mergeProfiles } from '../utils/profiles';

const ALL = 2 ** 31 - 1;
const DEFAULT = 135; // view, send, react, create invite
const guilds = [{ id: 5, name: 'Alpha', owner: 1, icon_version: 0 }, { id: 6, name: 'Beta', owner: 2, icon_version: 0 }];
const layout = (id, permissions, extra = {}) => ({
  ...guilds.find((g) => g.id === id), my_permissions: permissions, my_notify_level: 'mentions', roles: [], categories: [], channels: [], ...extra,
});

function renderRail({ layouts = { 5: layout(5, ALL), 6: layout(6, DEFAULT) }, unread = [], guildVoice, guildMentions, unreadFrom, path = '/dm' } = {}) {
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
          <MemoryRouter initialEntries={[path]}>
            <ShowPath />
            <Sidebar user={{ id: 1, username: 'owner' }} guilds={guilds} guildVoice={guildVoice} guildMentions={guildMentions} unreadFrom={unreadFrom} />
          </MemoryRouter>
        </LayoutContext.Provider>
      </InteractionContext.Provider>
    </ConfigContext.Provider>
  );
  return guildList;
}

function ShowPath() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

const items = (menu) => [...menu.querySelectorAll('[role^="menuitem"]')].map((b) => b.firstChild.firstChild.textContent);
const icon = (name) => screen.getByRole('link', { name });

beforeEach(() => {
  vi.clearAllMocks();
  myVoice = { status: 'idle', guildId: null };
});

describe('the rail\'s DM button', () => {
  it('shows its icon while nothing is unread', () => {
    renderRail();
    expect(icon('Direct Messages').querySelector('img')).toBeNull();
  });

  it('shows the picture of whoever sent the newest unread message', () => {
    mergeProfiles([{ id: 9, username: 'zed', display_name: 'Zed' }]);
    renderRail({ unreadFrom: 9 });
    const button = icon('Direct Messages: new message from Zed');
    expect(button).toHaveAttribute('href', '/dm');
    expect(button.querySelector('img')).not.toBeNull();
  });
});

describe('clicking where you already are', () => {
  const path = () => screen.getByTestId('path').textContent;

  it('stays in the open DM instead of going to bare /dm and back', () => {
    renderRail({ path: '/dm/7' });
    fireEvent.click(icon('Direct Messages'));
    expect(path()).toBe('/dm/7');
    fireEvent.click(icon('Alpha'));
    expect(path()).toBe('/guild/5');
  });

  it("stays in the open guild's channel, and still opens another guild", () => {
    renderRail({ path: '/guild/5/12' });
    fireEvent.click(icon('Alpha'));
    expect(path()).toBe('/guild/5/12');
    fireEvent.click(icon('Beta'));
    expect(path()).toBe('/guild/6');
    fireEvent.click(icon('Direct Messages'));
    expect(path()).toBe('/dm');
  });
});

describe('the guild rail voice speaker', () => {
  const badge = (name) => icon(name).parentElement.querySelector('.rail-voice-badge');

  it('is grey where others are in voice, green where you are, and none elsewhere', () => {
    renderRail({ guildVoice: { 5: 'others', 6: 'self' } });
    expect(badge('Alpha')).toHaveAttribute('aria-label', 'Someone is in voice here');
    expect(badge('Alpha')).not.toHaveClass('self');
    expect(badge('Beta')).toHaveAttribute('aria-label', "You're in voice here");
    expect(badge('Beta')).toHaveClass('self');
  });

  it("is green as soon as this device joins, and moves above a mention badge", () => {
    myVoice = { status: 'connecting', guildId: 6 };
    renderRail({ guildVoice: {}, guildMentions: { 6: 2 } });
    expect(badge('Alpha')).toBeNull();
    expect(badge('Beta')).toHaveClass('self');
    expect(badge('Beta')).toHaveClass('above');
  });
});

describe('the guild rail menu', () => {
  it("offers the owner's guild options (no Leave), and a member's (no settings)", () => {
    renderRail({ unread: [{ guild_id: 5, channel_id: 10, count: 2, mentions: 0 }] });
    fireEvent.contextMenu(icon('Alpha'));
    expect(items(screen.getByRole('menu', { name: 'Alpha' }))).toEqual([
      'Mark As Read', 'Invite People', 'Notification Settings', 'Guild Settings', 'Audit Log', 'Copy Link', 'Copy Guild ID',
    ]);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.contextMenu(icon('Beta'));
    expect(items(screen.getByRole('menu', { name: 'Beta' }))).toEqual(['Invite People', 'Notification Settings', 'Copy Link', 'Copy Guild ID', 'Leave Guild']);
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
