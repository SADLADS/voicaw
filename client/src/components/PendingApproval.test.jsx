// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn() },
}));

const approvedListeners = new Set();
vi.mock('../utils/ws-client', () => ({
  connectWebSocket: vi.fn(),
  onAccountApproved: (cb) => {
    approvedListeners.add(cb);
    return () => approvedListeners.delete(cb);
  },
}));

vi.mock('../services/authService', () => ({
  deleteAccount: vi.fn(),
}));

import { connectWebSocket } from '../utils/ws-client';
import { deleteAccount } from '../services/authService';
import PendingApproval from './PendingApproval';

const user = { id: 9, username: 'newbie', pending: true };

function renderPage() {
  const onApproved = vi.fn();
  const onLogout = vi.fn();
  const utils = render(<PendingApproval user={user} onApproved={onApproved} onLogout={onLogout} />);
  return { ...utils, onApproved, onLogout };
}

beforeEach(() => {
  vi.clearAllMocks();
  approvedListeners.clear();
});

describe('PendingApproval', () => {
  it('says the account waits, and opens the app once approved', () => {
    const { onApproved, unmount } = renderPage();
    expect(screen.getByText(/newbie, has been made/)).toBeInTheDocument();
    expect(connectWebSocket).toHaveBeenCalled();
    approvedListeners.forEach((cb) => cb());
    expect(onApproved).toHaveBeenCalled();
    unmount();
    expect(approvedListeners.size).toBe(0);
  });

  it('logs out', () => {
    const { onLogout } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(onLogout).toHaveBeenCalled();
  });

  it('withdraws the request with the password, deleting the account', async () => {
    const { onLogout } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw my request' }));
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'secret password' } });
    deleteAccount.mockRejectedValueOnce(new Error('Password is incorrect'));
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw and delete my account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Password is incorrect');
    expect(onLogout).not.toHaveBeenCalled();

    deleteAccount.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw and delete my account' }));
    await waitFor(() => expect(onLogout).toHaveBeenCalled());
    expect(deleteAccount).toHaveBeenCalledWith(user, 'secret password');
  });
});
