// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
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
});
