// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

// The websocket's "someone asked for an account": the panel loads again.
const signupListeners = new Set();
const testerListeners = new Set();
vi.mock('../utils/ws-client', () => ({
  onSignupRequests: (cb) => {
    signupListeners.add(cb);
    return () => signupListeners.delete(cb);
  },
  onTesterRequests: (cb) => {
    testerListeners.add(cb);
    return () => testerListeners.delete(cb);
  },
}));

import api from '../utils/api';
import AdminSettings from './AdminSettings';
import { AuthContext } from '../hooks/useAuth';

const klipy = (over = {}) => ({
  key: 'klipyApiKey', label: 'Klipy API key', description: 'GIF search.', secret: true,
  env: 'KLIPY_API_KEY', source: 'env', value: null, hint: '…ouur', ...over,
});

function renderAdmin() {
  return render(
    <AuthContext.Provider value={{ user: { id: 1, username: 'me' } }}>
      <AdminSettings />
    </AuthContext.Provider>
  );
}

const signupMode = (over = {}) => ({
  key: 'signupMode', label: 'Sign-ups', description: 'Who can make an account.', secret: false,
  env: 'SIGNUP_MODE', source: 'unset', value: 'open', choices: ['open', 'invite', 'request'], ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('AdminSettings', () => {
  it('shows nothing to non-admins', async () => {
    api.get.mockRejectedValue({ response: { status: 403 } });
    const { container } = renderAdmin();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin'));
    expect(container).toBeEmptyDOMElement();
  });

  it('replaces a secret without showing it, and goes back to .env', async () => {
    api.get.mockResolvedValue({ data: { settings: [klipy()], admins: [{ id: 1, username: 'me' }, { id: 2, username: 'bo' }] } });
    renderAdmin();
    expect(await screen.findByText('From server/.env: …ouur')).toBeInTheDocument();
    const input = screen.getByLabelText('Klipy API key');
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('type', 'password');

    api.put.mockResolvedValue({ data: { settings: [klipy({ source: 'admin', hint: '…1234' })] } });
    fireEvent.change(input, { target: { value: 'new-key-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Set here: …1234')).toBeInTheDocument();
    expect(api.put).toHaveBeenCalledWith('/admin/settings/klipyApiKey', { value: 'new-key-1234' });
    expect(input).toHaveValue('');

    api.put.mockResolvedValue({ data: { settings: [klipy()] } });
    fireEvent.click(screen.getByRole('button', { name: 'Use .env' }));
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/admin/settings/klipyApiKey', { value: null }));
  });

  it('lists admins; others can be removed, not yourself', async () => {
    api.get.mockResolvedValue({ data: { settings: [], admins: [{ id: 1, username: 'me' }, { id: 2, username: 'bo' }] } });
    renderAdmin();
    await screen.findByText('bo');
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
    api.delete.mockResolvedValue({ data: { admins: [{ id: 1, username: 'me' }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('bo')).not.toBeInTheDocument());
    expect(api.delete).toHaveBeenCalledWith('/admin/admins/2');
  });

  it('picks the sign-up mode from a menu, saved at once', async () => {
    api.get.mockResolvedValue({ data: { settings: [signupMode()], admins: [], requests: [], invites: [] } });
    renderAdmin();
    const menu = await screen.findByLabelText('Sign-ups');
    expect(menu).toHaveValue('open');
    expect(screen.getByText('Default')).toBeInTheDocument();

    api.put.mockResolvedValue({ data: { settings: [signupMode({ value: 'request', source: 'admin' })] } });
    fireEvent.change(menu, { target: { value: 'request' } });
    await waitFor(() => expect(menu).toHaveValue('request'));
    expect(api.put).toHaveBeenCalledWith('/admin/settings/signupMode', { value: 'request' });
    expect(screen.getByRole('option', { name: 'Request: admins approve new accounts' })).toBeInTheDocument();
  });

  it('approves and declines sign-up requests, and reloads when a new one comes', async () => {
    const waiting = [{ id: 7, username: 'newbie', display_name: null, account_created: 1700000000 }, { id: 8, username: 'other', display_name: null, account_created: 1700000100 }];
    api.get.mockResolvedValue({ data: { settings: [], admins: [], requests: waiting, invites: [] } });
    renderAdmin();
    await screen.findByText('newbie');

    api.post.mockResolvedValue({ data: { requests: [waiting[1]] } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    await waitFor(() => expect(screen.queryByText('newbie')).not.toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith('/admin/requests/7/approve');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.delete.mockResolvedValue({ data: { requests: [] } });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('Nobody is waiting.')).toBeInTheDocument();
    expect(api.delete).toHaveBeenCalledWith('/admin/requests/8');

    api.get.mockResolvedValue({ data: { settings: [], admins: [], requests: [waiting[0]], invites: [] } });
    signupListeners.forEach((cb) => cb(1));
    expect(await screen.findByText('newbie')).toBeInTheDocument();
  });

  it('creates invites (copying the link) and revokes them', async () => {
    api.get.mockResolvedValue({ data: { settings: [], admins: [], requests: [], invites: [] } });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAdmin();
    await screen.findByText('Invites');

    const invite = { code: 'Code123', uses: 0, max_uses: 1, expires_at: null, created_at: 1700000000 };
    api.post.mockResolvedValue({ data: { invite, invites: [invite] } });
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    expect(await screen.findByText(/\/join\/Code123$/)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/admin/invites', { maxAge: 7 * 24 * 60 * 60, maxUses: 1 });
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/join\/Code123$/));
    expect(screen.getByText(/Used 0 of 1/)).toBeInTheDocument();

    api.delete.mockResolvedValue({ data: { invites: [] } });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByText(/Code123/)).not.toBeInTheDocument());
    expect(api.delete).toHaveBeenCalledWith('/admin/invites/Code123');
  });

  it('lists Android tester requests, waiting first, to mark added, copy or remove', async () => {
    const testers = [
      { id: 7, email: 'pal@gmail.com', name: 'Pal', note: 'Pixel 7', created_at: 1_790_000_000, added_at: null },
      { id: 8, email: 'old@gmail.com', name: null, note: null, created_at: 1_789_000_000, added_at: 1_789_500_000 },
    ];
    api.get.mockImplementation(async (url) => (url === '/admin/tester-requests'
      ? { data: { testers } }
      : { data: { settings: [], admins: [], requests: [], invites: [] } }));
    renderAdmin();
    expect(await screen.findByText('pal@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('Pixel 7')).toBeInTheDocument();

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copy waiting emails' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('pal@gmail.com'));

    api.put.mockResolvedValue({ data: { testers: [{ ...testers[0], added_at: 1_790_000_100 }, testers[1]] } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark added' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/tester-requests/7', { added: true }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Not added' })).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Copy waiting emails' })).not.toBeInTheDocument();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.delete.mockResolvedValue({ data: { testers: [testers[0]] } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/tester-requests/8'));
    await waitFor(() => expect(screen.queryByText('old@gmail.com')).not.toBeInTheDocument());

    // Someone else asked: the list loads again.
    api.get.mockClear();
    testerListeners.forEach((cb) => cb());
    expect(api.get).toHaveBeenCalledWith('/admin/tester-requests');
  });

  it('shows why someone wants to join, and the reason setting only while sign-ups need approval', async () => {
    const reason = { key: 'signupReason', label: 'Sign-up reason', description: 'Ask why.', secret: false, env: null, source: 'unset', value: 'optional', choices: ['optional', 'required'] };
    const waiting = [{ id: 7, username: 'newbie', display_name: null, account_created: 1700000000, reason: 'My friends are here' }];
    api.get.mockResolvedValue({ data: { settings: [signupMode(), reason], admins: [], requests: waiting, invites: [] } });
    const { unmount } = renderAdmin();
    expect(await screen.findByText('My friends are here')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sign-up reason')).not.toBeInTheDocument();
    unmount();

    api.get.mockResolvedValue({ data: { settings: [signupMode({ value: 'request' }), reason], admins: [], requests: [], invites: [] } });
    renderAdmin();
    const menu = await screen.findByLabelText('Sign-up reason');
    expect(screen.getByRole('option', { name: 'Required' })).toBeInTheDocument();
    api.put.mockResolvedValue({ data: { settings: [signupMode({ value: 'request' }), { ...reason, value: 'required', source: 'admin' }] } });
    fireEvent.change(menu, { target: { value: 'required' } });
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/settings/signupReason', { value: 'required' }));
  });

  it('shows the history of sign-up and tester requests on asking, pages it and deletes from it', async () => {
    const decided = [
      { id: 3, username: 'yes', display_name: null, reason: 'Hi', requested_at: 1_790_000_000, status: 'approved', decided_at: 1_790_000_500, decided_by_username: 'boss' },
      { id: 2, username: 'no', display_name: null, reason: null, requested_at: 1_789_000_000, status: 'declined', decided_at: 1_789_000_500, decided_by_username: null },
    ];
    const older = { id: 1, username: 'early', display_name: null, reason: null, requested_at: 1_780_000_000, status: 'approved', decided_at: 1_780_000_500, decided_by_username: 'boss' };
    const removed = [{ id: 9, email: 'gone@gmail.com', name: null, note: 'Bye', created_at: 1_790_000_000, added_at: 1_790_000_100, removed_at: 1_790_000_200 }];
    api.get.mockImplementation(async (url, options) => {
      if (url === '/admin/requests/history') {
        return { data: options?.params?.before ? { history: [older], more: false } : { history: decided, more: true } };
      }
      if (url === '/admin/tester-requests/history') return { data: { history: removed, more: false } };
      if (url === '/admin/tester-requests') return { data: { testers: [] } };
      return { data: { settings: [], admins: [], requests: [], invites: [] } };
    });
    renderAdmin();
    await screen.findByText('Nobody has asked.');
    expect(api.get).not.toHaveBeenCalledWith('/admin/requests/history');

    const [signups, testers] = screen.getAllByRole('button', { name: 'Show history' });
    fireEvent.click(signups);
    expect(await screen.findByText('yes')).toBeInTheDocument();
    expect(screen.getByText(/Approved by boss/)).toBeInTheDocument();
    expect(screen.getByText(/Declined by an admin/)).toBeInTheDocument();
    expect(screen.getByText('Hi')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('early')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/admin/requests/history', { params: { before: '1789000500:2' } });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.delete.mockResolvedValue({ data: { ok: true } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    await waitFor(() => expect(screen.queryByText('yes')).not.toBeInTheDocument());
    expect(api.delete).toHaveBeenCalledWith('/admin/requests/history/3');

    fireEvent.click(testers);
    expect(await screen.findByText('gone@gmail.com')).toBeInTheDocument();
    expect(screen.getByText(/Removed/)).toBeInTheDocument();
    expect(screen.getByText('Bye')).toBeInTheDocument();
  });
});
