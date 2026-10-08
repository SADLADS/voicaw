// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/authService', () => ({
  MIN_PASSWORD_LENGTH: 10,
  changePassword: vi.fn(),
  createRecoveryCode: vi.fn(),
}));

import { changePassword, createRecoveryCode } from '../services/authService';
import { PasswordSettings, RecoveryCodeSettings } from './AccountSecuritySettings';
import { AuthContext } from '../hooks/useAuth';

function renderSettings(user = { id: 1, username: 'me', hasRecoveryCode: false }) {
  const setUser = vi.fn();
  render(
    <AuthContext.Provider value={{ user, setUser }}>
      <PasswordSettings />
      <RecoveryCodeSettings />
    </AuthContext.Provider>
  );
  return { setUser };
}

function fillPasswords(current, password, confirm = password) {
  fireEvent.change(screen.getByPlaceholderText('Current password'), { target: { value: current } });
  fireEvent.change(screen.getByPlaceholderText('New password'), { target: { value: password } });
  fireEvent.change(screen.getByPlaceholderText('New password again'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
}

beforeEach(() => vi.clearAllMocks());

describe('AccountSecuritySettings', () => {
  it('changes the password', async () => {
    changePassword.mockResolvedValue();
    renderSettings();
    fillPasswords('old password', 'new password!');
    expect(await screen.findByText('Password changed.')).toBeInTheDocument();
    expect(changePassword).toHaveBeenCalledWith('me', 'old password', 'new password!');
    expect(screen.getByPlaceholderText('Current password')).toHaveValue('');
  });

  it('refuses mismatched new passwords, and shows errors', async () => {
    changePassword.mockRejectedValue(new Error('Your current password is incorrect'));
    renderSettings();
    fillPasswords('old password', 'new password!', 'other password');
    expect(await screen.findByText("The new passwords don't match.")).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();

    fillPasswords('wrong', 'new password!');
    expect(await screen.findByText('Your current password is incorrect')).toBeInTheDocument();
  });

  it('sets up a recovery code with the password and shows it once', async () => {
    createRecoveryCode.mockResolvedValue('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
    const { setUser } = renderSettings();
    expect(screen.getByText(/don't have a recovery code yet/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set up a recovery code' }));
    fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value: 'my password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show my new code' }));

    expect(await screen.findByLabelText('Recovery code')).toHaveTextContent('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
    expect(createRecoveryCode).toHaveBeenCalledWith('me', 'my password');
    expect(setUser).toHaveBeenCalledWith({ id: 1, username: 'me', hasRecoveryCode: true });

    fireEvent.click(screen.getByLabelText("I've saved my recovery code"));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByLabelText('Recovery code')).toBeNull());
  });

  it('offers a new code when there is one already, and shows a wrong password', async () => {
    createRecoveryCode.mockRejectedValue(new Error('Your current password is incorrect'));
    renderSettings({ id: 1, username: 'me', hasRecoveryCode: true });
    fireEvent.click(screen.getByRole('button', { name: 'Make a new recovery code' }));
    fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show my new code' }));
    expect(await screen.findByText('Your current password is incorrect')).toBeInTheDocument();
  });
});
