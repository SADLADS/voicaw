// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('./utils/api', () => ({
  default: { get: vi.fn() },
}));

import api from './utils/api';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './hooks/useAuth';

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
    expect(api.get).toHaveBeenCalledWith('/profile');
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

  it('sets user to null when the profile request fails', async () => {
    api.get.mockRejectedValue(new Error('network error'));

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText('no user')).toBeInTheDocument());
  });
});
