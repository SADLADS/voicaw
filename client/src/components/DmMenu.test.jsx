// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('../services/dmService', () => ({
  markMessagesRead: vi.fn(async () => {}),
  setConversationSetting: vi.fn(async (kind, target, changes) => ({
    kind, target: String(target), pinned_at: changes.pinned ? 1000 : null, muted: Boolean(changes.mute), mute_until: null,
  })),
}));
vi.mock('../services/groupService', () => ({ markGroupReadToLatest: vi.fn(async () => {}) }));
const callState = vi.hoisted(() => ({ snapshot: { call: null, groupCalls: {} } }));
vi.mock('../voice/callClient', () => ({
  startCall: vi.fn(),
  startGroupCall: vi.fn(),
  getCallSnapshot: () => callState.snapshot,
  onCallChange: () => () => {},
}));

import DmSidebar from './DmSidebar';
import { ConfigContext, InteractionContext, LayoutContext } from '../contexts';
import { markMessagesRead, setConversationSetting } from '../services/dmService';
import { markGroupReadToLatest } from '../services/groupService';
import { startCall, startGroupCall } from '../voice/callClient';
import { applyAdminUsers } from '../utils/adminUsers';
import { AuthContext } from '../hooks/useAuth';

const me = { id: 9, username: 'me' };
const users = [
  { id: 1, username: 'alice', status: 'online', last_timestamp: 300 },
  { id: 2, username: 'bob', status: 'online', last_timestamp: 200 },
  { id: 3, username: 'carol', status: 'online', last_timestamp: 100 },
];
const group = { id: 'g-1', name: 'Trip', members: [me, users[0], users[1]], last_timestamp: 150, unread: 2 };

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderList({ settings = {}, unreadDms = [], isMobile = false, auth = null } = {}) {
  const conversationSettings = {
    get: (kind, target) => settings[`${kind}:${target}`] ?? { kind, target: String(target), pinned_at: null, muted: false, mute_until: null },
    isMuted: (kind, target) => Boolean(settings[`${kind}:${target}`]?.muted),
    apply: vi.fn(),
  };
  const layout = { conversationSettings, fetchUnreadMessages: vi.fn(async () => {}), groupList: { clearUnread: vi.fn() } };
  render(
    <AuthContext.Provider value={auth}>
      <ConfigContext.Provider value={{ s3Endpoint: '', voiceEnabled: true }}>
        <InteractionContext.Provider value={{ isMobile }}>
          <LayoutContext.Provider value={layout}>
            <MemoryRouter initialEntries={['/dm/3']}>
              <Routes>
                <Route path="/dm/*" element={<><DmSidebar user={me} users={users} groups={[group]} unreadDms={unreadDms} /><Where /></>} />
              </Routes>
            </MemoryRouter>
          </LayoutContext.Provider>
        </InteractionContext.Provider>
      </ConfigContext.Provider>
    </AuthContext.Provider>
  );
  return layout;
}

const order = () => [...document.querySelectorAll('.dm-user-list-container .dm-user')]
  .map((row) => row.querySelector('.dm-user-name, .dm-group-name').textContent);
const row = (name) => screen.getByText(name).closest('a');
const items = (menu) => [...menu.querySelectorAll('[role^="menuitem"]')].map((b) => b.firstChild.firstChild.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  callState.snapshot = { call: null, groupCalls: {} };
  applyAdminUsers(null);
});

describe('the DM list menu', () => {
  it('puts pinned conversations first, in the order pinned, and dims muted ones without a dot', () => {
    renderList({
      settings: {
        'dm:3': { kind: 'dm', target: '3', pinned_at: 1, muted: false },
        'group:g-1': { kind: 'group', target: 'g-1', pinned_at: 2, muted: true, mute_until: null },
      },
    });
    expect(order()).toEqual(['carol', 'Trip', 'alice', 'bob']);
    expect(row('Trip')).toHaveClass('muted');
    expect(row('Trip').querySelector('.userdot')).not.toHaveClass('active');
    expect(within(row('carol')).getByLabelText('Pinned')).toBeInTheDocument();
    expect(within(row('Trip')).getByLabelText('Muted')).toBeInTheDocument();
  });

  it("right-clicking a person: Mark As Read, Start Call, Pin, Mute", async () => {
    const layout = renderList({ unreadDms: [{ from_user_id: 1, count: 2 }] });
    fireEvent.contextMenu(row('alice'));
    const menu = screen.getByRole('menu', { name: 'alice' });
    expect(items(menu)).toEqual(['Mark As Read', 'Start Call', 'Pin Conversation', 'Mute Conversation', 'Copy User ID']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Mark As Read' }));
    await waitFor(() => expect(markMessagesRead).toHaveBeenCalledWith(1));
    await waitFor(() => expect(layout.fetchUnreadMessages).toHaveBeenCalled());

    fireEvent.contextMenu(row('alice'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin Conversation' }));
    await waitFor(() => expect(setConversationSetting).toHaveBeenCalledWith('dm', 1, { pinned: true }));
    await waitFor(() => expect(layout.conversationSettings.apply).toHaveBeenCalledWith(expect.objectContaining({ pinned_at: 1000 })));

    fireEvent.contextMenu(row('alice'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute Conversation' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Mute Conversation' })).getByRole('menuitem', { name: 'For 8 hours' }));
    await waitFor(() => expect(setConversationSetting).toHaveBeenCalledWith('dm', 1, { mute: { duration: 8 * 3600 } }));
  });

  it("a global admin's menu has Suspend Account and Make Admin", () => {
    applyAdminUsers({ admins: [9], suspended: [] });
    renderList({ auth: { user: me } });
    fireEvent.contextMenu(row('alice'));
    expect(items(screen.getByRole('menu', { name: 'alice' }))).toEqual([
      'Start Call', 'Pin Conversation', 'Mute Conversation', 'Make Admin', 'Suspend Account', 'Block', 'Report', 'Copy User ID',
    ]);
  });

  it('starts a call from the menu, opening the chat', async () => {
    renderList();
    fireEvent.contextMenu(row('bob'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start Call' }));
    await waitFor(() => expect(startCall).toHaveBeenCalledWith(users[1]));
    expect(screen.getByTestId('where')).toHaveTextContent('/dm/2');
  });

  it("a group's menu joins its call, marks it read and unmutes it; no call while in one", async () => {
    callState.snapshot = { call: null, groupCalls: { 'g-1': { id: 'c1' } } };
    const layout = renderList({ settings: { 'group:g-1': { kind: 'group', target: 'g-1', pinned_at: null, muted: true, mute_until: null } } });
    fireEvent.contextMenu(row('Trip'));
    const menu = screen.getByRole('menu', { name: 'Trip' });
    expect(items(menu)).toEqual(['Mark As Read', 'Join Call', 'Pin Conversation', 'Unmute Conversation']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Mark As Read' }));
    await waitFor(() => expect(markGroupReadToLatest).toHaveBeenCalledWith('g-1'));
    await waitFor(() => expect(layout.groupList.clearUnread).toHaveBeenCalledWith('g-1'));
    fireEvent.contextMenu(row('Trip'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Unmute Conversation/ }));
    await waitFor(() => expect(setConversationSetting).toHaveBeenCalledWith('group', 'g-1', { mute: false }));
    fireEvent.contextMenu(row('Trip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Join Call' }));
    await waitFor(() => expect(startGroupCall).toHaveBeenCalledWith('g-1'));

    callState.snapshot = { call: { id: 'c1' }, groupCalls: {} };
    fireEvent.contextMenu(row('alice'));
    expect(items(screen.getByRole('menu', { name: 'alice' }))).toEqual(['Pin Conversation', 'Mute Conversation', 'Copy User ID']);
  });
});
