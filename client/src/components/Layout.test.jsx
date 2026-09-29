// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useContext } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const newDmListeners = vi.hoisted(() => ({ list: [] }));

vi.mock('../utils/ws-client', () => ({
  connectWebSocket: vi.fn(),
  onNewDm: (cb) => {
    newDmListeners.list.push(cb);
    return () => { newDmListeners.list = newDmListeners.list.filter((x) => x !== cb); };
  },
  onUserStatus: () => () => {},
  onGuildEvent: () => () => {},
  getConnectionState: () => 'online',
  onConnectionState: () => () => {},
}));

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../services/dmService', () => ({
  fetchUsersList: vi.fn(),
}));

vi.mock('../services/guildService', () => ({
  fetchGuilds: vi.fn(async () => []),
  fetchGuild: vi.fn(),
  fetchGuildUnread: vi.fn(async () => []),
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
}));

import Layout from './Layout';
import { LayoutContext } from '../contexts';
import { ConfigContext } from '../contexts';
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

function renderLayout({ path, user = { id: 1, username: 'me' } } = {}) {
  return render(
    <ConfigContext.Provider value={{ vapidPublicKey: 'VAPID-KEY' }}>
    <MemoryRouter initialEntries={[path]}>
      <LocationDisplay />
      <Routes>
        <Route element={<Layout user={user} onLogout={vi.fn()} />}>
          <Route path="/dm/:id?" element={<ContextConsumer />} />
          <Route path="/settings" element={<ContextConsumer />} />
        </Route>
      </Routes>
    </MemoryRouter>
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
  it('does not fetch the DM user list on non-DM routes', async () => {
    renderLayout({ path: '/settings' });

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/dm-get-unread'));
    expect(fetchUsersList).not.toHaveBeenCalled();
    expect(document.getElementById('dm-sidebar')).not.toBeInTheDocument();
  });

  it('shows the user panel with the conversation list, not on Settings', async () => {
    fetchUsersList.mockResolvedValue([]);
    const { unmount } = renderLayout({ path: '/dm' });
    expect(screen.getByLabelText('You')).toHaveTextContent('me');
    unmount();

    renderLayout({ path: '/settings' });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByLabelText('You')).not.toBeInTheDocument();
  });

  it('fetches the DM user list on /dm routes and exposes it through LayoutContext', async () => {
    fetchUsersList.mockResolvedValue([
      { id: 7, username: 'bob', online: false },
      { id: 8, username: 'carol', online: true },
    ]);

    renderLayout({ path: '/dm/7' });

    expect(await screen.findByTestId('users')).toHaveTextContent('bob,carol');
    expect(document.getElementById('dm-sidebar')).toBeInTheDocument();
  });

  it('redirects /dm with no id to /dm/:firstUserId', async () => {
    fetchUsersList.mockResolvedValue([
      { id: 7, username: 'bob', online: false },
      { id: 8, username: 'carol', online: true },
    ]);

    renderLayout({ path: '/dm' });

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/dm/7'));
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
