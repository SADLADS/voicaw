// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Outlet } from 'react-router-dom';

vi.mock('./hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('./utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(async () => ({ data: { ok: true } })) },
}));

const loggedOut = vi.hoisted(() => ({ listener: null }));
vi.mock('./utils/ws-client', () => ({
  closeWebSocket: vi.fn(),
  onLoggedOutElsewhere: vi.fn((cb) => {
    loggedOut.listener = cb;
    return () => {};
  }),
}));

vi.mock('./services/keyStore', () => ({
  clearUserKeys: vi.fn(async () => {}),
}));

vi.mock('./components/Login.jsx', () => ({
  default: () => <div data-testid="login-page">LOGIN PAGE</div>,
}));

vi.mock('./components/Layout.jsx', () => ({
  default: ({ user }) => (
    <div data-testid="layout" data-user-id={user?.id}>
      <Outlet />
    </div>
  ),
}));



vi.mock('./components/Settings.jsx', () => ({
  default: ({ onLogout }) => (
    <button data-testid="settings-page" onClick={onLogout}>SETTINGS</button>
  ),
}));

vi.mock('./components/Dm.jsx', async () => {
  const { useContext } = await import('react');
  const { ConfigContext } = await import('./contexts');
  // Shows the ConfigContext it receives.
  function DmStub({ user }) {
    const config = useContext(ConfigContext);
    return (
      <div data-testid="dm-page" data-vapid={config?.vapidPublicKey ?? ''}>DM for {user?.username}</div>
    );
  }
  return { default: DmStub };
});

import App from './App';
import { ConfigContext } from './contexts';
import { useAuth } from './hooks/useAuth';
import api from './utils/api';
import { closeWebSocket } from './utils/ws-client';
import { clearUserKeys } from './services/keyStore';

function setPath(path) {
  window.history.pushState({}, '', path);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.get.mockResolvedValue({ data: { s3Endpoint: 'https://s3.test', maxPlaintextLength: 5000 } });
});

describe('App routing', () => {
  it('renders nothing while auth is still loading', () => {
    useAuth.mockReturnValue({ user: null, setUser: vi.fn(), loading: true });
    setPath('/');

    const { container } = render(<App />);

    expect(container.textContent).toBe('');
  });

  it('shows the login page at "/" when logged out', () => {
    useAuth.mockReturnValue({ user: null, setUser: vi.fn(), loading: false });
    setPath('/');

    render(<App />);

    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });

  it('redirects "/" to "/dm" when logged in', async () => {
    useAuth.mockReturnValue({ user: { id: 1, username: 'alice' }, setUser: vi.fn(), loading: false });
    setPath('/');

    render(<App />);

    expect(await screen.findByTestId('dm-page')).toHaveTextContent('DM for alice');
    expect(screen.getByTestId('layout')).toHaveAttribute('data-user-id', '1');
  });

  it('shows an unknown path as the login page when logged out', () => {
    useAuth.mockReturnValue({ user: null, setUser: vi.fn(), loading: false });
    setPath('/some/unknown/path');

    render(<App />);

    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });

  it('renders Settings under Layout for a logged-in user', () => {
    useAuth.mockReturnValue({ user: { id: 1, username: 'alice' }, setUser: vi.fn(), loading: false });

    setPath('/settings');
    const { unmount } = render(<App />);
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    expect(screen.getByTestId('layout')).toBeInTheDocument();
    unmount();
  });

  it('logs out (clears storage, closes the socket, and nulls the user) when Settings triggers onLogout', async () => {
    const setUser = vi.fn();
    useAuth.mockReturnValue({ user: { id: 1, username: 'alice' }, setUser, loading: false });
    setPath('/settings');
    localStorage.setItem('token', 'jwt-abc');

    render(<App />);
    fireEvent.click(screen.getByTestId('settings-page'));

    await waitFor(() => expect(setUser).toHaveBeenCalledWith(null));
    expect(closeWebSocket).toHaveBeenCalled();
    expect(localStorage.getItem('token')).toBeNull();
    expect(clearUserKeys).toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith('/logout', null, { headers: { Authorization: 'Bearer jwt-abc' } });
  });

  it("can log out on this device while the server can't be reached, without asking it", async () => {
    useAuth.mockReturnValue({ user: null, setUser: vi.fn(), loading: true, unreachable: true });
    localStorage.setItem('token', 'jwt-abc');
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Log out on this device' }));

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(localStorage.getItem('token')).toBeNull();
    expect(clearUserKeys).toHaveBeenCalled();
    expect(closeWebSocket).toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('logs out when logged out from another device (or the account is deleted there)', async () => {
    const setUser = vi.fn();
    useAuth.mockReturnValue({ user: { id: 1, username: 'alice' }, setUser, loading: false });
    setPath('/dm');
    localStorage.setItem('token', 'jwt-abc');

    render(<App />);
    await waitFor(() => expect(loggedOut.listener).toBeTruthy());
    loggedOut.listener();

    await waitFor(() => expect(setUser).toHaveBeenCalledWith(null));
    expect(localStorage.getItem('token')).toBeNull();
  });
});

describe('App terms of use', () => {
  it('shows only the terms to someone who has not accepted them, then the app', async () => {
    const setUser = vi.fn();
    useAuth.mockReturnValue({ user: { id: 1, username: 'alice', termsAccepted: false }, setUser, loading: false });
    setPath('/dm');
    const { unmount } = render(<App />);
    expect(screen.getByRole('heading', { name: 'Terms of use' })).toBeInTheDocument();
    expect(screen.queryByTestId('layout')).not.toBeInTheDocument();
    unmount();

    useAuth.mockReturnValue({ user: { id: 1, username: 'alice', termsAccepted: true }, setUser, loading: false });
    render(<App />);
    expect(await screen.findByTestId('layout')).toBeInTheDocument();
  });
});

describe('App config', () => {
  it('passes everything from /api/config (including the VAPID key) to the app', async () => {
    api.get.mockResolvedValue({
      data: { s3Endpoint: 'https://s3.test', maxPlaintextLength: 5000, vapidPublicKey: 'VAPID-KEY' },
    });
    useAuth.mockReturnValue({ user: { id: 1, username: 'alice' }, setUser: vi.fn(), loading: false });
    setPath('/dm');

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('dm-page')).toHaveAttribute('data-vapid', 'VAPID-KEY'));
  });

  it('asks again until the server answers (pictures need its s3Endpoint), and when back online', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      api.get
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockResolvedValue({ data: { s3Endpoint: 'https://s3.test', vapidPublicKey: 'VAPID-KEY' } });
      useAuth.mockReturnValue({ user: { id: 1, username: 'alice' }, setUser: vi.fn(), loading: false });
      setPath('/dm');

      render(<App />);
      await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('dm-page')).toHaveAttribute('data-vapid', '');

      // Back online: at once, rather than after the wait.
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
      // Then after the (doubling) wait.
      await vi.advanceTimersByTimeAsync(4000);
      await vi.waitFor(() => expect(screen.getByTestId('dm-page')).toHaveAttribute('data-vapid', 'VAPID-KEY'));
      expect(api.get).toHaveBeenCalledTimes(3);

      // Once it has the config, it stops asking.
      await vi.advanceTimersByTimeAsync(60000);
      window.dispatchEvent(new Event('online'));
      expect(api.get).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('profile pictures', () => {
  it('redraw once the address of the pictures is known', async () => {
    const { mergeProfiles, setAvatarBase, avatarUrl, useProfiles } = await import('./utils/profiles');
    const { act } = await import('react');
    setAvatarBase('');
    mergeProfiles([{ id: 7, username: 'sam', avatar: 'pic' }]);
    function Picture() {
      useProfiles();
      return <span data-testid="pic">{avatarUrl(7) ?? 'default'}</span>;
    }
    render(<Picture />);
    expect(screen.getByTestId('pic')).toHaveTextContent('default');
    act(() => setAvatarBase('https://s3.test'));
    expect(screen.getByTestId('pic')).toHaveTextContent('https://s3.test/profile-pics/7/pic.webp');
  });
});

