// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

vi.mock('./utils/api', () => ({
  default: { get: vi.fn() },
}));
vi.mock('./services/logout', () => ({ forgetLogin: vi.fn(async () => {}) }));

import api from './utils/api';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './hooks/useAuth';
import { isOfflineMode, setOfflineMode, useOfflineMode } from './utils/offlineMode';

function Consumer() {
  const { user, loading } = useAuth();
  if (loading) return <div>loading</div>;
  if (!user) return <div>no user</div>;
  return (
    <div>
      logged in as {user.username} (id {user.id}, token {user.token})
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('token', 'saved-jwt');
});

describe('AuthProvider', () => {
  it('shows a loading state before the profile fetch resolves', () => {
    api.get.mockReturnValue(new Promise(() => {})); // never resolves
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>
    );

    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('populates the user from a successful /profile response', async () => {
    api.get.mockResolvedValue({
      data: { id: 7, username: 'alice', token: 'jwt-abc', private_key: 'enc-key', vapidPubKey: 'vapid-pub' },
    });

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>
    );

    await waitFor(() =>
      expect(screen.getByText(/logged in as alice \(id 7, token jwt-abc\)/)).toBeInTheDocument()
    );
    expect(api.get).toHaveBeenCalledWith('/profile', { timeout: expect.any(Number), offlineCopy: 'fallback' });
  });

  it('sets user to null when the response has no id', async () => {
    api.get.mockResolvedValue({ data: {} });

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText('no user')).toBeInTheDocument());
  });

  it('sets user to null when the server refuses the saved login', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('forbidden'), { response: { status: 403 } }));

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText('no user')).toBeInTheDocument());
  });

  it('keeps the saved login and tries again while the server is out of reach', async () => {
    vi.useFakeTimers();
    try {
      api.get
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockRejectedValueOnce(Object.assign(new Error('bad gateway'), { response: { status: 502 } }))
        .mockResolvedValue({ data: { id: 7, username: 'alice', token: 'saved-jwt' } });

      render(
        <AuthProvider>
          <Consumer />
        </AuthProvider>
      );

      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText('loading')).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(screen.getByText('loading')).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(screen.getByText(/logged in as alice/)).toBeInTheDocument();
      expect(api.get).toHaveBeenCalledTimes(3);
      expect(localStorage.getItem('token')).toBe('saved-jwt');
    } finally {
      vi.useRealTimers();
    }
  });

  // The server out of reach, the offline copy answering: offline mode, until it's back.
  it('opens offline from the offline copy, then says when the server is back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setOfflineMode(false);
    try {
      api.get
        .mockResolvedValueOnce({ data: { id: 7, username: 'alice', token: 't' }, fromOfflineCopy: true })
        .mockRejectedValueOnce(Object.assign(new Error('Network Error'), { response: undefined }))
        .mockResolvedValueOnce({ data: { id: 7, username: 'alice' } });
      function Reachable() {
        const { reachable } = useOfflineMode();
        return <div>{reachable ? 'reachable' : 'waiting'}</div>;
      }
      render(
        <AuthProvider>
          <Consumer />
          <Reachable />
        </AuthProvider>
      );
      await waitFor(() => expect(screen.getByText(/logged in as alice/)).toBeInTheDocument());
      expect(isOfflineMode()).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByText('waiting')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      await waitFor(() => expect(screen.getByText('reachable')).toBeInTheDocument());
      expect(api.get).toHaveBeenLastCalledWith('/profile', { timeout: expect.any(Number), offlineCopy: 'never' });
    } finally {
      vi.useRealTimers();
      setOfflineMode(false);
    }
  });

  it('does not ask the server without a saved login', async () => {
    localStorage.removeItem('token');

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText('no user')).toBeInTheDocument());
    expect(api.get).not.toHaveBeenCalled();
  });
});
