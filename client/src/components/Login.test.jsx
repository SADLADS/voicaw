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
  generateECDH_P256_PEM: vi.fn(),
  encryptPrivateKey: vi.fn(),
  decryptPrivateKey: vi.fn(),
}));

vi.mock('../utils/ws-client', () => ({
  connectWebSocket: vi.fn(),
}));

vi.mock('../services/keyStore', () => ({
  storePrivateKey: vi.fn(async () => {}),
}));

import * as opaque from '@serenity-kit/opaque';
import api from '../utils/api';
import { generateECDH_P256_PEM, encryptPrivateKey, decryptPrivateKey } from '../services/encryptionService';
import { connectWebSocket } from '../utils/ws-client';
import { storePrivateKey } from '../services/keyStore';
import Login from './Login';

function renderLogin(onLoginSuccess = vi.fn()) {
  const utils = render(<Login onLoginSuccess={onLoginSuccess} />);
  const forms = utils.container.querySelectorAll('form');
  return { ...utils, onLoginSuccess, loginForm: forms[0], registerForm: forms[1] };
}

function fillLogin(container, username, password) {
  fireEvent.change(container.querySelector('input[name="username"]'), { target: { value: username } });
  fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: password } });
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

  it('logs in successfully: decrypts the private key, stores it, connects the socket, and calls onLoginSuccess', async () => {
    opaque.client.startLogin.mockReturnValue({ clientLoginState: 'CLS', startLoginRequest: 'SLR' });
    opaque.client.finishLogin.mockReturnValue({ finishLoginRequest: 'FLR', sessionKey: 'SK' });
    decryptPrivateKey.mockResolvedValue('decrypted-private-pem');

    api.post.mockImplementation(async (url) => {
      if (url === '/initiatelogin') return { data: { loginResponse: 'LR' } };
      if (url === '/finaliselogin') {
        return { data: { token: 'jwt123', private_key: 'enc-pk', userId: 5, vapidPubKey: 'vapid-pub' } };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { loginForm, container, onLoginSuccess } = renderLogin();
    fillLogin(container, 'alice', 'hunter2');
    fireEvent.submit(loginForm);

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());

    expect(storePrivateKey).toHaveBeenCalledWith('decrypted-private-pem');
    expect(localStorage.getItem('privateKey')).toBeNull();
    expect(localStorage.getItem('token')).toBe('jwt123');
    expect(connectWebSocket).toHaveBeenCalled();
    expect(onLoginSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'jwt123', userId: 5 })
    );
  });

  it('shows an error when the OPAQUE login exchange fails', async () => {
    opaque.client.startLogin.mockReturnValue({ clientLoginState: 'CLS', startLoginRequest: 'SLR' });
    opaque.client.finishLogin.mockReturnValue(null);
    api.post.mockResolvedValue({ data: { loginResponse: 'LR' } });

    const { loginForm, container } = renderLogin();
    fillLogin(container, 'alice', 'wrongpassword');
    fireEvent.submit(loginForm);

    expect(await screen.findByText('Login failed')).toBeInTheDocument();
  });

  it('shows the server error message when finaliselogin returns one', async () => {
    opaque.client.startLogin.mockReturnValue({ clientLoginState: 'CLS', startLoginRequest: 'SLR' });
    opaque.client.finishLogin.mockReturnValue({ finishLoginRequest: 'FLR', sessionKey: 'SK' });

    api.post.mockImplementation(async (url) => {
      if (url === '/initiatelogin') return { data: { loginResponse: 'LR' } };
      if (url === '/finaliselogin') return { data: { error: 'Invalid credentials' } };
    });

    const { loginForm, container } = renderLogin();
    fillLogin(container, 'alice', 'hunter2');
    fireEvent.submit(loginForm);

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
  });
});

describe('Login - register form', () => {
  function fillRegister(container, username, password) {
    const usernameInputs = container.querySelectorAll('input[name="username"]');
    const passwordInputs = container.querySelectorAll('input[name="password"]');
    fireEvent.change(usernameInputs[1], { target: { value: username } });
    fireEvent.change(passwordInputs[1], { target: { value: password } });
  }

  it('registers, stores the private key/token, and calls onLoginSuccess when a token is issued', async () => {
    opaque.client.startRegistration.mockReturnValue({
      clientRegistrationState: 'CRS',
      registrationRequest: 'RR',
    });
    generateECDH_P256_PEM.mockResolvedValue({ publicPEM: 'PUB-PEM', privatePEM: 'PRIV-PEM' });
    encryptPrivateKey.mockResolvedValue('ENC-PRIV-PEM');
    opaque.client.finishRegistration.mockReturnValue({ registrationRecord: 'REC' });

    api.post.mockImplementation(async (url) => {
      if (url === '/initiateregister') return { data: { registrationResponse: 'RR2' } };
      if (url === '/finaliseregister') return { data: { token: 'reg-jwt' } };
      throw new Error(`unexpected url ${url}`);
    });

    const { registerForm, container, onLoginSuccess } = renderLogin();
    fillRegister(container, 'newuser', 'newpass123');
    fireEvent.submit(registerForm);

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());

    expect(storePrivateKey).toHaveBeenCalledWith('PRIV-PEM');
    expect(localStorage.getItem('privateKey')).toBeNull();
    expect(localStorage.getItem('token')).toBe('reg-jwt');
    expect(onLoginSuccess).toHaveBeenCalledWith(expect.objectContaining({ token: 'reg-jwt' }));
  });

  it('alerts the user to log in manually when registration succeeds without a token', async () => {
    opaque.client.startRegistration.mockReturnValue({
      clientRegistrationState: 'CRS',
      registrationRequest: 'RR',
    });
    generateECDH_P256_PEM.mockResolvedValue({ publicPEM: 'PUB-PEM', privatePEM: 'PRIV-PEM' });
    encryptPrivateKey.mockResolvedValue('ENC-PRIV-PEM');
    opaque.client.finishRegistration.mockReturnValue({ registrationRecord: 'REC' });

    api.post.mockImplementation(async (url) => {
      if (url === '/initiateregister') return { data: { registrationResponse: 'RR2' } };
      if (url === '/finaliseregister') return { data: {} };
    });

    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { registerForm, container, onLoginSuccess } = renderLogin();
    fillRegister(container, 'newuser', 'newpass123');
    fireEvent.submit(registerForm);

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Registered! You can now log in.'));
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('shows the server error message when initiateregister fails', async () => {
    opaque.client.startRegistration.mockReturnValue({
      clientRegistrationState: 'CRS',
      registrationRequest: 'RR',
    });
    generateECDH_P256_PEM.mockResolvedValue({ publicPEM: 'PUB-PEM', privatePEM: 'PRIV-PEM' });
    encryptPrivateKey.mockResolvedValue('ENC-PRIV-PEM');

    api.post.mockImplementation(async (url) => {
      if (url === '/initiateregister') return { data: { error: 'Username taken' } };
    });

    const { registerForm, container } = renderLogin();
    fillRegister(container, 'existinguser', 'newpass123');
    fireEvent.submit(registerForm);

    expect(await screen.findByText('Username taken')).toBeInTheDocument();
  });
});
