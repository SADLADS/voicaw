// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/authService', () => ({
  fetchTwoFactor: vi.fn(),
  newTwoFactorSecret: vi.fn(() => ({ secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', uri: 'otpauth://totp/Voicaw:me?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=Voicaw' })),
  enableTwoFactor: vi.fn(),
  disableTwoFactor: vi.fn(),
  newBackupCodes: vi.fn(),
}));

import { fetchTwoFactor, enableTwoFactor, disableTwoFactor, newBackupCodes } from '../services/authService';
import TwoFactorSettings from './TwoFactorSettings';
import { AuthContext } from '../hooks/useAuth';

const CODES = ['aaaa-bbbb', 'cccc-dddd'];

function renderSettings() {
  render(
    <AuthContext.Provider value={{ user: { id: 1, username: 'me' }, setUser: vi.fn() }}>
      <TwoFactorSettings />
    </AuthContext.Provider>
  );
}

beforeEach(() => vi.clearAllMocks());

describe('TwoFactorSettings', () => {
  it('sets it up: QR code and key, then a code and the password, then the backup codes', async () => {
    fetchTwoFactor.mockResolvedValueOnce({ enabled: false, backupCodesLeft: 0 }).mockResolvedValue({ enabled: true, backupCodesLeft: 2 });
    enableTwoFactor.mockResolvedValue(CODES);
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up two-factor' }));

    expect(await screen.findByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(screen.getByLabelText('Key for your authenticator app')).toHaveTextContent('ABCD EFGH IJKL');
    fireEvent.change(screen.getByPlaceholderText('Six-digit code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value: 'my password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));

    await waitFor(() => expect(enableTwoFactor).toHaveBeenCalledWith('me', 'my password', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', '123456'));
    expect(await screen.findByText('aaaa-bbbb')).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I've saved my backup codes"));
    fireEvent.click(done);
    expect(await screen.findByText(/^On\./)).toBeInTheDocument();
    expect(screen.getByText('2 backup codes left.')).toBeInTheDocument();
  });

  it('shows why it could not turn on', async () => {
    fetchTwoFactor.mockResolvedValue({ enabled: false, backupCodesLeft: 0 });
    enableTwoFactor.mockRejectedValue(new Error("That code doesn't match"));
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up two-factor' }));
    fireEvent.change(screen.getByPlaceholderText('Six-digit code'), { target: { value: '000000' } });
    fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value: 'my password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That code doesn't match");
  });

  it('turns off with the password and a code', async () => {
    fetchTwoFactor.mockResolvedValueOnce({ enabled: true, backupCodesLeft: 10 }).mockResolvedValue({ enabled: false, backupCodesLeft: 0 });
    disableTwoFactor.mockResolvedValue();
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off two-factor' }));
    fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value: 'my password' } });
    fireEvent.change(screen.getByPlaceholderText('Six-digit code or backup code'), { target: { value: 'aaaa-bbbb' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Turn off two-factor' }));
    await waitFor(() => expect(disableTwoFactor).toHaveBeenCalledWith('me', 'my password', 'aaaa-bbbb'));
    expect(await screen.findByRole('button', { name: 'Set up two-factor' })).toBeInTheDocument();
  });

  it('makes new backup codes', async () => {
    fetchTwoFactor.mockResolvedValue({ enabled: true, backupCodesLeft: 1 });
    newBackupCodes.mockResolvedValue(CODES);
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'New backup codes' }));
    fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value: 'my password' } });
    fireEvent.change(screen.getByPlaceholderText('Six-digit code or backup code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show new backup codes' }));
    expect(await screen.findByText('cccc-dddd')).toBeInTheDocument();
    expect(newBackupCodes).toHaveBeenCalledWith('me', 'my password', '654321');
  });
});
