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

describe('AuthorizePage for Login with Voicaw', () => {
  const REDIRECT = 'https://games.example/callback';
  const login = (over = {}) => ({
    login: true,
    id: 41,
    name: 'Games Site',
    description: null,
    bot: { id: 41, username: 'gamessite', discriminator: '0420', avatar: null },
    owner: { id: 3, username: 'alice', display_name: 'Alice' },
    created_at: 1790000000,
    scopes: ['identify'],
    redirect_uri: REDIRECT,
    authorized: false,
    ...over,
  });
  const query = `client_id=41&response_type=code&scope=identify&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz`;
  const request = { client_id: '41', response_type: 'code', scope: 'identify', redirect_uri: REDIRECT, state: 'xyz' };
  let assign;

  beforeEach(() => {
    assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
  });

  it('says what the site gets and where you go, and sends you back with the code', async () => {
    api.get.mockResolvedValue({ data: login() });
    api.post.mockResolvedValue({ data: { location: `${REDIRECT}?code=abc&state=xyz` } });
    renderAt(query);
    expect(await screen.findByText('Games Site wants to use your Voicaw account')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/oauth2/authorize', { params: request });
    expect(screen.getByText('Know your username, display name and profile picture')).toBeInTheDocument();
    expect(screen.getByText(/you'll go to games\.example/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Authorise' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`${REDIRECT}?code=abc&state=xyz`));
    expect(api.post).toHaveBeenCalledWith('/oauth2/authorize', { ...request, deny: false });
    expect(screen.getByRole('status')).toHaveTextContent('Taking you back to games.example');
  });

  it('cancelling tells the site', async () => {
    api.get.mockResolvedValue({ data: login() });
    api.post.mockResolvedValue({ data: { location: `${REDIRECT}?error=access_denied&state=xyz` } });
    renderAt(query);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/oauth2/authorize', { ...request, deny: true }));
    expect(assign).toHaveBeenCalledWith(`${REDIRECT}?error=access_denied&state=xyz`);
  });

  it("doesn't ask again with prompt=none once you've let it in", async () => {
    api.get.mockResolvedValue({ data: login({ authorized: true }) });
    api.post.mockResolvedValue({ data: { location: `${REDIRECT}?code=abc&state=xyz` } });
    renderAt(`${query}&prompt=none`);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`${REDIRECT}?code=abc&state=xyz`));
    expect(screen.queryByRole('button', { name: 'Authorise' })).toBeNull();
  });

  it('never leaves for an unknown redirect, but tells the site about its own mistakes', async () => {
    api.get.mockRejectedValue({ response: { status: 400, data: { error: 'Invalid "redirect_uri" in request.' } } });
    renderAt(query);
    expect(await screen.findByRole('alert')).toHaveTextContent("This login link doesn't work");
    expect(assign).not.toHaveBeenCalled();

    api.get.mockRejectedValue({ response: { status: 400, data: { error: 'Unknown scope', redirect: `${REDIRECT}?error=invalid_scope` } } });
    renderAt(query.replace('scope=identify', 'scope=email'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`${REDIRECT}?error=invalid_scope`));
  });
});
