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
    expect(api.post).toHaveBeenCalledWith('/logout');
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
});

