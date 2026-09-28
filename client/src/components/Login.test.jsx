// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@serenity-kit/opaque', () => ({
  client: {
    startLogin: vi.fn(),
    finishLogin: vi.fn(),
    startRegistration: vi.fn(),
    finishRegistration: vi.fn(),
  },
}));

vi.mock('../utils/api', () => ({
  default: { post: vi.fn() },
}));

vi.mock('../services/encryptionService', () => ({
  generateUserKeys: vi.fn(),
  wrapKeyBackup: vi.fn(),
  unwrapKeyBackup: vi.fn(),
}));

vi.mock('../utils/ws-client', () => ({
  connectWebSocket: vi.fn(),
}));

vi.mock('../services/keyStore', () => ({
  storeUserKeys: vi.fn(async () => {}),
}));

import * as opaque from '@serenity-kit/opaque';
import api from '../utils/api';
import { generateUserKeys, wrapKeyBackup, unwrapKeyBackup } from '../services/encryptionService';
import { connectWebSocket } from '../utils/ws-client';
import { storeUserKeys } from '../services/keyStore';
import Login from './Login';

const PUBLIC = { identityKey: 'ID-PUB', encryptionKey: 'ENC-PUB', encryptionKeySignature: 'SIG' };
const PRIVATE = { identityKey: 'ID-PRIV', encryptionKey: 'ENC-PRIV' };
const KEYS = { public: PUBLIC, private: PRIVATE };

function renderLogin(onLoginSuccess = vi.fn()) {
  const utils = render(<Login onLoginSuccess={onLoginSuccess} />);
  const forms = utils.container.querySelectorAll('form');
  return { ...utils, onLoginSuccess, loginForm: forms[0], registerForm: forms[1] };
}

function fillLogin(container, username, password) {
  fireEvent.change(container.querySelector('input[name="username"]'), { target: { value: username } });
  fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: password } });
}

function fillRegister(container, username, password) {
  fireEvent.change(container.querySelectorAll('input[name="username"]')[1], { target: { value: username } });
  fireEvent.change(container.querySelectorAll('input[name="password"]')[1], { target: { value: password } });
}

function mockLoginExchange(finaliseResponse) {
  opaque.client.startLogin.mockReturnValue({ clientLoginState: 'CLS', startLoginRequest: 'SLR' });
  opaque.client.finishLogin.mockReturnValue({ finishLoginRequest: 'FLR', sessionKey: 'SK', exportKey: 'EXPORT-KEY' });
  api.post.mockImplementation(async (url) => {
    if (url === '/initiatelogin') return { data: { loginResponse: 'LR' } };
    if (url === '/finaliselogin') return { data: finaliseResponse };
    throw new Error(`unexpected url ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Login - login form', () => {
  it('shows a validation error when submitted without username/password', async () => {
    const { loginForm } = renderLogin();
    fireEvent.submit(loginForm);

    expect(await screen.findByText('Username and password are required')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('opens the key backup with the OPAQUE exportKey, stores the keys, and logs in', async () => {
    mockLoginExchange({ token: 'jwt123', id: 5, username: 'alice', keyBackup: 'BACKUP', ...PUBLIC });
    unwrapKeyBackup.mockResolvedValue(KEYS);

    const { loginForm, container, onLoginSuccess } = renderLogin();
    fillLogin(container, 'alice', 'hunter2-hunter2');
    fireEvent.submit(loginForm);
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());

    expect(unwrapKeyBackup).toHaveBeenCalledWith('EXPORT-KEY', 'BACKUP');
    expect(storeUserKeys).toHaveBeenCalledWith(5, KEYS);
    expect(localStorage.getItem('token')).toBe('jwt123');
    expect(connectWebSocket).toHaveBeenCalled();
    expect(onLoginSuccess).toHaveBeenCalledWith({ token: 'jwt123', id: 5, username: 'alice' });
    // The client's OPAQUE login state is its secret: it must never be sent to the server.
    expect(api.post).toHaveBeenCalledWith('/initiatelogin', { startLoginRequest: 'SLR', userIdentifier: 'alice' });
    for (const [, body] of api.post.mock.calls) expect(body).not.toHaveProperty('clientLoginState');
  });

  it('refuses to log in if the server publishes different public keys than the backup holds', async () => {
    mockLoginExchange({ token: 'jwt123', id: 5, username: 'alice', keyBackup: 'BACKUP', ...PUBLIC, encryptionKey: 'SERVER-SWAPPED' });
    unwrapKeyBackup.mockResolvedValue(KEYS);

    const { loginForm, container, onLoginSuccess } = renderLogin();
    fillLogin(container, 'alice', 'hunter2-hunter2');
    fireEvent.submit(loginForm);

    expect(await screen.findByText(/public keys doesn't match your account/)).toBeInTheDocument();
    expect(storeUserKeys).not.toHaveBeenCalled();
    expect(localStorage.getItem('token')).toBeNull();
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('does not log in if the key backup cannot be opened', async () => {
    mockLoginExchange({ token: 'jwt123', id: 5, username: 'alice', keyBackup: 'BACKUP', ...PUBLIC });
    unwrapKeyBackup.mockRejectedValue(new Error('OperationError'));

    const { loginForm, container, onLoginSuccess } = renderLogin();
    fillLogin(container, 'alice', 'hunter2-hunter2');
    fireEvent.submit(loginForm);

    expect(await screen.findByText("Couldn't unlock your encryption keys.")).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('shows the same error for a wrong password and an unknown username', async () => {
    opaque.client.startLogin.mockReturnValue({ clientLoginState: 'CLS', startLoginRequest: 'SLR' });
    opaque.client.finishLogin.mockReturnValue(undefined);
    api.post.mockResolvedValue({ data: { loginResponse: 'LR' } });

    const { loginForm, container } = renderLogin();
    fillLogin(container, 'alice', 'wrong');
    fireEvent.submit(loginForm);

    expect(await screen.findByText('Incorrect username or password')).toBeInTheDocument();
  });
});

describe('Login - register form', () => {
  it('generates keys, backs them up with the OPAQUE exportKey, and registers', async () => {
    opaque.client.startRegistration.mockReturnValue({ clientRegistrationState: 'CRS', registrationRequest: 'RR' });
    opaque.client.finishRegistration.mockReturnValue({ registrationRecord: 'REC', exportKey: 'EXPORT-KEY' });
    generateUserKeys.mockResolvedValue(KEYS);
    wrapKeyBackup.mockResolvedValue('BACKUP');
    api.post.mockImplementation(async (url) => {
      if (url === '/initiateregister') return { data: { registrationResponse: 'RRESP' } };
      if (url === '/finaliseregister') return { data: { token: 'reg-jwt', id: 9, username: 'newuser' } };
      throw new Error(`unexpected url ${url}`);
    });

    const { registerForm, container, onLoginSuccess } = renderLogin();
    fillRegister(container, 'newuser', 'long enough password');
    fireEvent.submit(registerForm);
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());

    expect(wrapKeyBackup).toHaveBeenCalledWith('EXPORT-KEY', KEYS);
    const [, body] = api.post.mock.calls.find(([url]) => url === '/finaliseregister');
    expect(body).toEqual({ registrationRecord: 'REC', userIdentifier: 'newuser', ...PUBLIC, keyBackup: 'BACKUP' });
    expect(JSON.stringify(body)).not.toContain('PRIV');
    expect(storeUserKeys).toHaveBeenCalledWith(9, KEYS);
    expect(localStorage.getItem('token')).toBe('reg-jwt');
  });

  it('requires a password of at least 10 characters', async () => {
    const { registerForm, container } = renderLogin();
    fillRegister(container, 'newuser', 'short');
    fireEvent.submit(registerForm);

    expect(await screen.findByText('Use a password of at least 10 characters.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('alerts the user to log in manually when registration succeeds without a token', async () => {
    opaque.client.startRegistration.mockReturnValue({ clientRegistrationState: 'CRS', registrationRequest: 'RR' });
    opaque.client.finishRegistration.mockReturnValue({ registrationRecord: 'REC', exportKey: 'EXPORT-KEY' });
    generateUserKeys.mockResolvedValue(KEYS);
    wrapKeyBackup.mockResolvedValue('BACKUP');
    api.post.mockImplementation(async (url) => {
      if (url === '/initiateregister') return { data: { registrationResponse: 'RRESP' } };
      if (url === '/finaliseregister') return { data: {} };
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    const { registerForm, container, onLoginSuccess } = renderLogin();
    fillRegister(container, 'newuser', 'long enough password');
    fireEvent.submit(registerForm);

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Registered! You can now log in.'));
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('shows the server error message when initiateregister fails', async () => {
    opaque.client.startRegistration.mockReturnValue({ clientRegistrationState: 'CRS', registrationRequest: 'RR' });
    api.post.mockImplementation(async (url) => {
      if (url === '/initiateregister') return { data: { error: 'Username taken' } };
    });

    const { registerForm, container } = renderLogin();
    fillRegister(container, 'existinguser', 'long enough password');
    fireEvent.submit(registerForm);

    expect(await screen.findByText('Username taken')).toBeInTheDocument();
  });
});
