// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import api from '../../utils/api';
import DeveloperPortal from './DeveloperPortal';

const app = (over = {}) => ({
  id: 41,
  name: 'Weather Bot',
  description: null,
  public: true,
  created_at: 1790000000,
  token_reset_at: 1790000000,
  bot: { id: 41, username: 'weatherbot', discriminator: '0420', avatar: null },
  guilds: [],
  ...over,
});

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/developers" element={<DeveloperPortal />} />
        <Route path="/developers/applications/:appId" element={<DeveloperPortal />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue() } });
});

describe('DeveloperPortal', () => {
  it('lists your applications, and makes a new one, showing its token once', async () => {
    api.get.mockImplementation((url) => Promise.resolve({ data: url === '/applications' ? [app()] : app({ id: 42, name: 'Rain Bot', bot: { id: 42, username: 'rainbot', discriminator: '0001', avatar: null } }) }));
    api.post.mockResolvedValue({ data: { ...app({ id: 42, name: 'Rain Bot' }), token: 'NDI.AAAA.secret' } });
    renderAt('/developers');
    expect(await screen.findByRole('button', { name: 'Open Weather Bot' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to Voicaw/ })).toHaveAttribute('href', '/dm');

    fireEvent.click(screen.getByRole('button', { name: /New Application/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Rain Bot' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/applications', { name: 'Rain Bot' }));

    // Its page opens on the Bot tab with the token.
    expect(await screen.findByDisplayValue('NDI.AAAA.secret')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Bot' })).toHaveAttribute('aria-selected', 'true');
    expect(api.get).toHaveBeenCalledWith('/applications/42');
  });

  it('resets the token after asking, and shows the new one', async () => {
    api.get.mockResolvedValue({ data: app() });
    api.post.mockResolvedValue({ data: { token: 'NDE.BBBB.fresh' } });
    renderAt('/developers/applications/41');
    fireEvent.click(await screen.findByRole('tab', { name: 'Bot' }));
    expect(screen.getByDisplayValue('weatherbot#0420')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/fresh/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Token' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset Token' }));
    expect(await screen.findByDisplayValue('NDE.BBBB.fresh')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/applications/41/token');
    fireEvent.click(screen.getByDisplayValue('NDE.BBBB.fresh').parentElement.querySelector('button'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('NDE.BBBB.fresh'));
  });

  it("builds the invite link from the ticked permissions, with Discord's bits", async () => {
    api.get.mockResolvedValue({ data: app({ guilds: [{ id: 7, name: 'Weather Fans', icon_version: 0 }] }) });
    api.delete.mockResolvedValue({ data: { success: true } });
    renderAt('/developers/applications/41');
    fireEvent.click(await screen.findByRole('tab', { name: 'Installation' }));
    const link = () => screen.getByLabelText('Invite link').value;
    const bits = (url) => BigInt(new URL(url).searchParams.get('permissions'));
    expect(link()).toMatch(/\/oauth2\/authorize\?client_id=41&scope=bot&permissions=\d+$/);
    expect(bits(link()) & (1n << 11n)).toBe(1n << 11n); // Send Messages by default

    fireEvent.click(screen.getByLabelText('Kick Members'));
    expect(bits(link()) & (1n << 1n)).toBe(1n << 1n);
    fireEvent.click(screen.getByLabelText('Send Messages'));
    expect(bits(link()) & (1n << 11n)).toBe(0n);

    // Taken out of a guild.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Weather Fans')).toBeNull());
    expect(api.delete).toHaveBeenCalledWith('/applications/41/guilds/7');
  });

  it('saves the name and description, and deletes after asking', async () => {
    api.get.mockResolvedValue({ data: app() });
    api.patch.mockResolvedValue({ data: app({ name: 'Sun Bot', description: 'Sunny days' }) });
    api.delete.mockResolvedValue({ data: { success: true } });
    renderAt('/developers/applications/41');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Sun Bot' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Sunny days' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/applications/41', { name: 'Sun Bot', description: 'Sunny days' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Application' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/applications/41'));
  });
});
