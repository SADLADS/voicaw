// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/authService', () => ({
  deleteAccount: vi.fn(),
}));

import { deleteAccount } from '../services/authService';
import DeleteAccountSettings from './DeleteAccountSettings';
import { AuthContext } from '../hooks/useAuth';
import { LayoutContext } from '../contexts';

const me = { id: 1, username: 'me' };

function renderSection(guilds = []) {
  const onDeleted = vi.fn();
  render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user: me, setUser: vi.fn() }}>
        <LayoutContext.Provider value={{ guildList: { guilds } }}>
          <DeleteAccountSettings onDeleted={onDeleted} />
        </LayoutContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
  return { onDeleted };
}

const typePassword = (value) => fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value } });
const confirmButton = () => screen.getByRole('button', { name: 'Delete my account' });

beforeEach(() => vi.clearAllMocks());

describe('DeleteAccountSettings', () => {
  it('deletes with the password, then logs out', async () => {
    deleteAccount.mockResolvedValue({ ok: true });
    const { onDeleted } = renderSection([{ id: 5, name: 'Theirs', owner: 2 }]);
    expect(screen.queryByRole('group', { name: 'Guilds you own' })).toBeNull();
    typePassword('secret password');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(deleteAccount).toHaveBeenCalledWith(me, 'secret password', { deleteOwnedGuilds: false });
  });

  it('lists owned guilds and only goes ahead once deleting them is ticked', async () => {
    deleteAccount.mockResolvedValue({ ok: true });
    const { onDeleted } = renderSection([{ id: 5, name: 'Mine', owner: 1 }, { id: 6, name: 'Also mine', owner: 1 }]);
    expect(screen.getByRole('group', { name: 'Guilds you own' })).toHaveTextContent('You own 2 guilds');
    expect(screen.getByRole('link', { name: 'Mine' })).toHaveAttribute('href', '/guild/5');
    typePassword('secret password');
    expect(confirmButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(deleteAccount).toHaveBeenCalledWith(me, 'secret password', { deleteOwnedGuilds: true });
  });

  it("shows the server's list when it says you own guilds, and the error", async () => {
    deleteAccount.mockRejectedValueOnce(Object.assign(new Error('Transfer ownership of your guilds or delete them first'), {
      code: 'owns_guilds', guilds: [{ id: 9, name: 'Just made' }],
    }));
    const { onDeleted } = renderSection();
    typePassword('secret password');
    fireEvent.click(confirmButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Transfer ownership');
    expect(screen.getByRole('link', { name: 'Just made' })).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
