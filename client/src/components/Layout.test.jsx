// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useContext } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const newDmListeners = vi.hoisted(() => ({ list: [] }));

vi.mock('../utils/ws-client', () => ({
  connectWebSocket: vi.fn(),
  onNewDm: (cb) => {
    newDmListeners.list.push(cb);
    return () => { newDmListeners.list = newDmListeners.list.filter((x) => x !== cb); };
  },
  onGuildEvent: () => () => {},
  onGroupEvent: () => () => {},
  onBotDmEvent: () => () => {},
  getConnectionState: () => 'online',
  onConnectionState: () => () => {},
  onConversationSettings: () => () => {},
  onPreferences: () => () => {},
  onBlocks: () => () => {},
  onFriends: () => () => {},
  onDictionary: () => () => {},
  onEmojiUsage: () => () => {},
}));

// Group DMs (tested with their hooks and in e2e/groups.mjs): none here.
vi.mock('../services/groupService', () => ({ fetchGroups: vi.fn(async () => []) }));
// Bot DMs (BotDm.test.jsx, e2e/botdms.mjs): none here.
vi.mock('../services/botDmService', () => ({ fetchBotDms: vi.fn(async () => []) }));

// DM calls (tested in voice/callClient.test.js): none here.
const noCall = vi.hoisted(() => ({ call: null }));
vi.mock('../voice/callClient', () => ({
  initCalls: vi.fn(),
  getCallSnapshot: () => noCall,
  onCallChange: () => () => {},
  acceptCall: vi.fn(),
  declineCall: vi.fn(),
  hangUp: vi.fn(),
}));
vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../services/dmService', () => ({
  fetchUsersList: vi.fn(),
  fetchConversationSettings: vi.fn(async () => []),
}));

vi.mock('../services/guildService', () => ({
  fetchGuilds: vi.fn(async () => []),
  fetchGuild: vi.fn(),
  fetchGuildUnread: vi.fn(async () => []),
  fetchAllEmojis: vi.fn(async () => []),
  saveGuildOrder: vi.fn(async () => {}),
}));

vi.mock('../services/encryptionService', () => ({
  decryptMessage: vi.fn(async () => 'decrypted-plaintext'),
  deriveSharedKey: vi.fn(async () => 'shared-key'),
}));

vi.mock('../services/pushService', () => ({
  getPushStatus: vi.fn(() => 'can-enable'),
  ensureSubscription: vi.fn(async () => {}),
}));

vi.mock('../services/keyStore', () => ({
  loadPrivateKey: vi.fn(async () => 'fake-private-key'),
  loadEncryptionKey: vi.fn(async () => null),
  loadOwnPublicKeys: vi.fn(async () => null),
}));

import Layout from './Layout';
import { applyFriends } from '../utils/friends';
import { LayoutContext } from '../contexts';
import { ConfigContext, InteractionContext } from '../contexts';
import { getPushStatus, ensureSubscription } from '../services/pushService';
import api from '../utils/api';
import { fetchUsersList } from '../services/dmService';
import { connectWebSocket } from '../utils/ws-client';

function ContextConsumer() {
  const { users, errorUsers, hasUnreadDms, unreadDms } = useContext(LayoutContext);
  return (
    <div>
      <div data-testid="users">{users.map((u) => u.username).join(',')}</div>
      <div data-testid="errorUsers">{errorUsers || ''}</div>
      <div data-testid="hasUnreadDms">{String(hasUnreadDms)}</div>
      <div data-testid="unreadCount">{unreadDms.length}</div>
    </div>
  );
}

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderLayout({ path, user = { id: 1, username: 'me' }, isMobile = false } = {}) {
  // The address bar, as the app's routers keep it (Layout reads it, see the /dm landing).
  window.history.replaceState(null, '', path);
  return render(
    <ConfigContext.Provider value={{ vapidPublicKey: 'VAPID-KEY' }}>
    <InteractionContext.Provider value={{ isMobile }}>
    <MemoryRouter initialEntries={[path]}>
      <LocationDisplay />
      <Routes>
        <Route element={<Layout user={user} onLogout={vi.fn()} />}>
          <Route path="/dm/:id?" element={<ContextConsumer />} />
          <Route path="/settings" element={<ContextConsumer />} />
        </Route>
      </Routes>
    </MemoryRouter>
    </InteractionContext.Provider>
    </ConfigContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  newDmListeners.list = [];
  api.get.mockResolvedValue({ data: [] });
  fetchUsersList.mockResolvedValue([]);
});

describe('Layout', () => {
  it("loads everyone's profile once on other pages, without the DM list", async () => {
    renderLayout({ path: '/settings' });

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/dm-get-unread'));
    await waitFor(() => expect(fetchUsersList).toHaveBeenCalledTimes(1));
    expect(api.get).toHaveBeenCalledWith('/profile');
    expect(document.getElementById('dm-sidebar')).not.toBeInTheDocument();
  });

  it("shows the user panel with the conversation list, and under Settings' column on a computer", async () => {
    fetchUsersList.mockResolvedValue([]);
    let view = renderLayout({ path: '/dm' });
    expect(screen.getByLabelText('You')).toHaveTextContent('me');
    view.unmount();

    view = renderLayout({ path: '/settings' });
    expect(screen.getByLabelText('You')).toHaveTextContent('me');
    expect(document.querySelector('.sidebar-wrapper .settings-nav-slot')).toBeInTheDocument();
    view.unmount();

    // A phone has it too: Settings' column is the list pane, with the user panel under it,
    // and /settings alone opens on that list.
    renderLayout({ path: '/settings', isMobile: true });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.getByLabelText('You')).toHaveTextContent('me');
    expect(document.querySelector('.sidebar-wrapper .settings-nav-slot')).toBeInTheDocument();
    expect(document.querySelector('.main-wrapper')).toHaveClass('slidey', 'pane-list');
  });

  it('fetches the DM user list on /dm routes and exposes it through LayoutContext', async () => {
    fetchUsersList.mockResolvedValue([
      { id: 7, username: 'bob', status: 'offline' },
      { id: 8, username: 'carol', status: 'online' },
    ]);

    renderLayout({ path: '/dm/7' });

    expect(await screen.findByTestId('users')).toHaveTextContent('bob,carol');
    expect(document.getElementById('dm-sidebar')).toBeInTheDocument();
  });

  it('redirects /dm with no id to your latest conversation', async () => {
    fetchUsersList.mockResolvedValue([
      { id: 7, username: 'bob', status: 'offline', last_timestamp: 200 },
      { id: 8, username: 'carol', status: 'online', last_timestamp: 100 },
    ]);

    renderLayout({ path: '/dm' });

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/dm/7'));
  });

  it('redirects /dm to the Friends page when you have no conversations', async () => {
    fetchUsersList.mockResolvedValue([{ id: 7, username: 'bob', status: 'offline', last_timestamp: null }]);

    renderLayout({ path: '/dm' });

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/dm/friends'));
  });

  it("doesn't redirect /dm once the app has moved on (a tapped notification that started it)", async () => {
    let answer;
    fetchUsersList.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    renderLayout({ path: '/dm' });
    await waitFor(() => expect(fetchUsersList).toHaveBeenCalled());

    // The navigation has changed the address, but react-router hasn't rendered it yet.
    window.history.replaceState(null, '', '/dm/8');
    answer([{ id: 7, username: 'bob', status: 'offline', last_timestamp: 200 }]);

    await waitFor(() => expect(screen.getByTestId('users')).toHaveTextContent('bob'));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/dm$/);
  });

  it("puts someone who isn't a friend in the DM list with their first message", async () => {
    applyFriends({ friends: [], incoming: [], outgoing: [] });
    fetchUsersList.mockResolvedValue([{ id: 7, username: 'bob', status: 'offline', last_timestamp: null }]);
    renderLayout({ path: '/dm/8' });
    await waitFor(() => expect(fetchUsersList).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('users')).toHaveTextContent('bob'));
    expect(document.querySelector('#dm-sidebar a[href="/dm/7"]')).toBeNull();

    act(() => newDmListeners.list.forEach((cb) => cb({ sender_id: 7, recipient_id: 1, timestamp: 100 })));
    expect(document.querySelector('#dm-sidebar a[href="/dm/7"]')).not.toBeNull();
  });

  it('surfaces an error from fetchUsersList via errorUsers', async () => {
    fetchUsersList.mockRejectedValue(new Error('failed to load users'));

    renderLayout({ path: '/dm/7' });

    // The element exists (empty) before the fetch fails, so wait for the text itself.
    await waitFor(() => expect(screen.getByTestId('errorUsers')).toHaveTextContent('failed to load users'));
  });

  it('loads unread DMs into context on mount', async () => {
    api.get.mockResolvedValue({ data: [{ id: 1 }, { id: 2 }] });

    renderLayout({ path: '/settings' });

    expect(await screen.findByTestId('hasUnreadDms')).toHaveTextContent('true');
    expect(screen.getByTestId('unreadCount')).toHaveTextContent('2');
  });

  it('connects the websocket for the logged-in user', () => {
    renderLayout({ path: '/settings', user: { id: 42, username: 'me' } });

    expect(connectWebSocket).toHaveBeenCalledWith(42);
  });
});

describe('Layout push notifications', () => {
  it('re-syncs this device\'s push subscription on start when notifications are allowed', async () => {
    getPushStatus.mockReturnValue('granted');
    renderLayout({ path: '/dm' });

    await waitFor(() => expect(ensureSubscription).toHaveBeenCalledWith('VAPID-KEY'));
  });

  it('does not subscribe (or prompt) on start otherwise; that needs a tap', async () => {
    for (const status of ['can-enable', 'off', 'denied', 'needs-install']) {
      getPushStatus.mockReturnValue(status);
      const { unmount } = renderLayout({ path: '/dm' });
      await new Promise((r) => setTimeout(r, 10));
      unmount();
    }
    expect(ensureSubscription).not.toHaveBeenCalled();
  });
});
