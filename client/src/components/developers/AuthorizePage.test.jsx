// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import api from '../../utils/api';
import AuthorizePage from './AuthorizePage';
import { PERMISSIONS as P } from '../../utils/permissions';

const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const KICK = 1n << 1n;

const info = (over = {}) => ({
  id: 41,
  name: 'Weather Bot',
  description: 'Tells you the weather',
  bot: { id: 41, username: 'weatherbot', discriminator: '0420', avatar: null },
  owner: { id: 3, username: 'alice', display_name: 'Alice' },
  created_at: 1790000000,
  guilds: [
    { id: 7, name: 'Weather Fans', icon_version: 0, my_permissions: P.VIEW_CHANNEL | P.SEND_MESSAGES | P.KICK_MEMBERS | P.MANAGE_GUILD },
    { id: 8, name: 'Mods Only', icon_version: 0, my_permissions: P.VIEW_CHANNEL | P.SEND_MESSAGES | P.MANAGE_GUILD },
  ],
  ...over,
});

function renderAt(query) {
  return render(
    <MemoryRouter initialEntries={[`/oauth2/authorize?${query}`]}>
      <Routes>
        <Route path="/oauth2/authorize" element={<AuthorizePage />} />
        <Route path="/guild/:guildId" element={<p>guild page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => vi.clearAllMocks());

describe('AuthorizePage', () => {
  it("shows the bot and what it asks for, and adds it with what's still ticked", async () => {
    api.get.mockResolvedValue({ data: info() });
    api.post.mockResolvedValue({ data: { success: true, guild_id: 7 } });
    renderAt(`client_id=41&scope=bot&permissions=${VIEW | SEND | KICK}`);
    expect(await screen.findByText('Made by Alice')).toBeInTheDocument();
    expect(screen.getByText('Tells you the weather')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/oauth2/authorize', { params: { client_id: '41' } });
    // Only what it asks for.
    expect(screen.getByLabelText('Kick Members')).toBeChecked();
    expect(screen.queryByLabelText('Ban Members')).toBeNull();

    const submit = screen.getByRole('button', { name: 'Authorise' });
    expect(submit).toBeDisabled(); // no guild chosen yet
    fireEvent.change(screen.getByLabelText('Add to guild'), { target: { value: '7' } });
    fireEvent.click(screen.getByLabelText('Send Messages'));
    fireEvent.click(submit);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/oauth2/authorize', { client_id: '41', guild_id: 7, permissions: String(VIEW | KICK) }));
    expect(await screen.findByText('Weather Bot has been added to Weather Fans.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Weather Fans' }));
    expect(await screen.findByText('guild page')).toBeInTheDocument();
  });

  it("can't give permissions you don't have in the guild chosen", async () => {
    api.get.mockResolvedValue({ data: info() });
    api.post.mockResolvedValue({ data: { success: true } });
    renderAt(`client_id=41&permissions=${VIEW | KICK}`);
    fireEvent.change(await screen.findByLabelText('Add to guild'), { target: { value: '8' } });
    expect(screen.getByLabelText('Kick Members')).toBeDisabled();
    expect(screen.getByLabelText('Kick Members')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Authorise' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/oauth2/authorize', { client_id: '41', guild_id: 8, permissions: String(VIEW) }));
  });

  it('says so for an unknown or private bot, and for a link without one', async () => {
    api.get.mockRejectedValue({ response: { status: 404, data: { error: 'Unknown application' } } });
    renderAt('client_id=99');
    expect(await screen.findByRole('alert')).toHaveTextContent("This bot doesn't exist");

    renderAt('scope=bot');
    expect(screen.getByText("This link doesn't say which bot to add.")).toBeInTheDocument();
  });
});
