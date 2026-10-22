// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@serenity-kit/opaque', () => ({
  client: {
    startLogin: vi.fn(),
    finishLogin: vi.fn(),
    startRegistration: vi.fn(),
    finishRegistration: vi.fn(),
  },
  ready: Promise.resolve(),
}));

vi.mock('../utils/api', () => ({
  default: { post: vi.fn(), get: vi.fn(), put: vi.fn() },
}));

vi.mock('../services/encryptionService', () => ({
  generateUserKeys: vi.fn(),
  wrapKeyBackup: vi.fn(),
  unwrapKeyBackup: vi.fn(),
  generateRecoveryCode: vi.fn(() => 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE'),
  normalizeRecoveryCode: vi.fn((code) => (code.replace(/-/g, '').length === 25 ? code.replace(/-/g, '') : null)),
  recoveryAuth: vi.fn(async () => 'REC-AUTH'),
  recoveryVerifier: vi.fn(async () => 'REC-VERIFIER'),
  wrapRecoveryBackup: vi.fn(async () => 'REC-BACKUP'),
  unwrapRecoveryBackup: vi.fn(),
}));

vi.mock('../utils/ws-client', () => ({
  connectWebSocket: vi.fn(),
}));

vi.mock('../services/keyStore', () => ({
  storeUserKeys: vi.fn(async () => {}),
}));

import * as opaque from '@serenity-kit/opaque';
import api from '../utils/api';
import {
  generateUserKeys, wrapKeyBackup, unwrapKeyBackup, unwrapRecoveryBackup, generateRecoveryCode, wrapRecoveryBackup,
} from '../services/encryptionService';
import { connectWebSocket } from '../utils/ws-client';
import { storeUserKeys } from '../services/keyStore';
import Login from './Login';
import { ConfigContext } from '../contexts';

const PUBLIC = { identityKey: 'ID-PUB', encryptionKey: 'ENC-PUB', encryptionKeySignature: 'SIG' };
const PRIVATE = { identityKey: 'ID-PRIV', encryptionKey: 'ENC-PRIV' };
const KEYS = { public: PUBLIC, private: PRIVATE };

function renderLogin(onLoginSuccess = vi.fn()) {
  const utils = render(
    <ConfigContext.Provider value={{ termsVersion: '2026-10-05' }}>
      <Login onLoginSuccess={onLoginSuccess} />
    </ConfigContext.Provider>
  );
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
    mockLoginExchange({ token: 'jwt123', id: 5, username: 'alice', keyBackup: 'BACKUP', hasRecoveryCode: true, ...PUBLIC });
    unwrapKeyBackup.mockResolvedValue(KEYS);

    const { loginForm, container, onLoginSuccess } = renderLogin();
    fillLogin(container, 'alice', 'hunter2-hunter2');
    fireEvent.submit(loginForm);
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());

    expect(unwrapKeyBackup).toHaveBeenCalledWith('EXPORT-KEY', 'BACKUP');
    expect(storeUserKeys).toHaveBeenCalledWith(5, KEYS);
    expect(localStorage.getItem('token')).toBe('jwt123');
    expect(connectWebSocket).toHaveBeenCalled();
    expect(onLoginSuccess).toHaveBeenCalledWith({ token: 'jwt123', id: 5, username: 'alice', hasRecoveryCode: true, pending: false, termsAccepted: true });
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

  it("shows the server's reason when it refuses, e.g. too many attempts", async () => {
    opaque.client.startLogin.mockReturnValue({ clientLoginState: 'CLS', startLoginRequest: 'SLR' });
    api.post.mockRejectedValue(Object.assign(new Error('Request failed with status code 429'), {
      response: { status: 429, data: { error: 'Too many attempts. Try again in 15 minutes.' } },
    }));

    const { loginForm, container } = renderLogin();
    fillLogin(container, 'alice', 'whatever-password');
    fireEvent.submit(loginForm);

    expect(await screen.findByText('Too many attempts. Try again in 15 minutes.')).toBeInTheDocument();
  });
});

describe('Login - two-factor', () => {
  function mockTwoFactorLogin(onCode) {
    opaque.client.startLogin.mockReturnValue({ clientLoginState: 'CLS', startLoginRequest: 'SLR' });
    opaque.client.finishLogin.mockReturnValue({ finishLoginRequest: 'FLR', sessionKey: 'SK', exportKey: 'EXPORT-KEY' });
    api.post.mockImplementation(async (url, body) => {
      if (url === '/initiatelogin') return { data: { loginResponse: 'LR' } };
      if (url === '/finaliselogin') return { data: { twoFactor: true, ticket: 'TICKET' } };
      if (url === '/login/two-factor') return onCode(body);
      throw new Error(`unexpected url ${url}`);
    });
  }

  it('asks for a code, then opens the key backup with the same login', async () => {
    let tries = 0;
    mockTwoFactorLogin(async ({ code }) => {
      if (tries++ === 0) throw Object.assign(new Error('401'), { response: { data: { error: 'That code is wrong or has been used already', code: 'two_factor_invalid' } } });
      expect(code).toBe('123456');
      return { data: { token: 'jwt2fa', id: 5, username: 'alice', keyBackup: 'BACKUP', hasRecoveryCode: true, ...PUBLIC } };
    });
    unwrapKeyBackup.mockResolvedValue(KEYS);

    const { loginForm, container, onLoginSuccess } = renderLogin();
    fillLogin(container, 'alice', 'hunter2-hunter2');
    fireEvent.submit(loginForm);
    const input = await screen.findByPlaceholderText('Code or backup code');
    expect(unwrapKeyBackup).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '000000' } });
    fireEvent.submit(input.closest('form'));
    expect(await screen.findByText('That code is wrong or has been used already')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: ' 123456 ' } });
    fireEvent.submit(input.closest('form'));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/login/two-factor', { ticket: 'TICKET', code: '123456' });
    expect(unwrapKeyBackup).toHaveBeenCalledWith('EXPORT-KEY', 'BACKUP');
    expect(localStorage.getItem('token')).toBe('jwt2fa');
  });

  it('goes back to the password when the ticket has expired', async () => {
    mockTwoFactorLogin(async () => {
      throw Object.assign(new Error('401'), { response: { data: { error: 'Please log in again', code: 'two_factor_expired' } } });
    });
    const { loginForm, container } = renderLogin();
    fillLogin(container, 'alice', 'hunter2-hunter2');
    fireEvent.submit(loginForm);
    const input = await screen.findByPlaceholderText('Code or backup code');
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.submit(input.closest('form'));
    expect(await screen.findByText('That took too long. Log in again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument();
  });
});

describe('Login - account without a recovery code', () => {
  async function logInWithoutCode() {
    mockLoginExchange({ token: 'jwt123', id: 5, username: 'alice', keyBackup: 'BACKUP', hasRecoveryCode: false, ...PUBLIC });
    unwrapKeyBackup.mockResolvedValue(KEYS);
    api.get.mockResolvedValue({ data: { keyBackup: 'BACKUP' } });
    const utils = renderLogin();
    fillLogin(utils.container, 'alice', 'hunter2-hunter2');
    fireEvent.submit(utils.loginForm);
    expect(await screen.findByLabelText('Recovery code')).toHaveTextContent('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
    expect(screen.getByText(/doesn't have a recovery code yet/)).toBeInTheDocument();
    return utils;
  }

  it('shows a new code first and stores it only once the user continues', async () => {
    const { onLoginSuccess } = await logInWithoutCode();
    expect(api.put).not.toHaveBeenCalled();
    expect(onLoginSuccess).not.toHaveBeenCalled();

    api.put.mockResolvedValue({ data: { ok: true } });
    fireEvent.click(screen.getByLabelText("I've saved my recovery code"));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith({ token: 'jwt123', id: 5, username: 'alice', hasRecoveryCode: true, pending: false, termsAccepted: true }));

    // Stored with a fresh proof of the password, from the keys opened on this device.
    expect(api.put).toHaveBeenCalledWith('/recovery-code', {
      finishLoginRequest: 'FLR', clientSessionKey: 'SK', recoveryVerifier: 'REC-VERIFIER', recoveryBackup: 'REC-BACKUP',
    });
    expect(api.post.mock.calls.filter(([url]) => url === '/initiatelogin')).toHaveLength(2);
    expect(connectWebSocket).toHaveBeenCalled();
  });

  it('can skip if storing the code fails, and is asked again next time', async () => {
    const { onLoginSuccess } = await logInWithoutCode();
    api.put.mockRejectedValue(Object.assign(new Error('429'), { response: { data: { error: 'Too many attempts.' } } }));
    fireEvent.click(screen.getByLabelText("I've saved my recovery code"));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(/Too many attempts\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(onLoginSuccess).toHaveBeenCalledWith({ token: 'jwt123', id: 5, username: 'alice', hasRecoveryCode: false, pending: false, termsAccepted: true });
  });
});

describe('Login - register form', () => {
  function mockRegistration(finalise = { token: 'reg-jwt', id: 9, username: 'newuser' }) {
    opaque.client.startRegistration.mockReturnValue({ clientRegistrationState: 'CRS', registrationRequest: 'RR' });
    opaque.client.finishRegistration.mockReturnValue({ registrationRecord: 'REC', exportKey: 'EXPORT-KEY' });
    generateUserKeys.mockResolvedValue(KEYS);
    wrapKeyBackup.mockResolvedValue('BACKUP');
    api.post.mockImplementation(async (url) => {
      if (url === '/initiateregister') return { data: { registrationResponse: 'RRESP' } };
      if (url === '/finaliseregister') return { data: finalise };
      throw new Error(`unexpected url ${url}`);
    });
  }

  function renderWithMode(signupMode, props = {}, signupReason = undefined) {
    const onLoginSuccess = vi.fn();
    const utils = render(
      <ConfigContext.Provider value={{ signupMode, signupReason }}>
        <Login onLoginSuccess={onLoginSuccess} {...props} />
      </ConfigContext.Provider>
    );
    return { ...utils, onLoginSuccess, registerForm: utils.container.querySelectorAll('form')[1] };
  }

  it('has no invite field while sign-ups are open', () => {
    const { container } = renderWithMode('open');
    expect(container.querySelector('input[name="invite"]')).toBeNull();
  });

  it('needs an invite when sign-ups are invite only, and sends the code from a pasted link', async () => {
    mockRegistration();
    const { container, registerForm } = renderWithMode('invite');
    const field = container.querySelector('input[name="invite"]');
    expect(field).toBeRequired();
    fillRegister(container, 'newuser', 'long enough password');
    fireEvent.change(field, { target: { value: ' https://app.voicaw.com/join/Abc123XYZ ' } });
    fireEvent.submit(registerForm);
    await screen.findByLabelText('Recovery code');
    const started = api.post.mock.calls.find(([url]) => url === '/initiateregister')[1];
    expect(started).toMatchObject({ signup: true, invite: 'Abc123XYZ' });
    expect(api.post.mock.calls.find(([url]) => url === '/finaliseregister')[1].invite).toBe('Abc123XYZ');
  });

  it('fills in the code from an invite link, optional when sign-ups need approval', () => {
    const { container } = renderWithMode('request', { invite: 'FromLink1' });
    const field = container.querySelector('input[name="invite"]');
    expect(field).toHaveValue('FromLink1');
    expect(field).not.toBeRequired();
    expect(screen.getByText(/wait for an admin to approve/)).toBeInTheDocument();
  });

  it('asks why they want to join only while sign-ups need approval, and sends it', async () => {
    expect(renderWithMode('open').container.querySelector('textarea[name="reason"]')).toBeNull();
    cleanup();
    expect(renderWithMode('invite').container.querySelector('textarea[name="reason"]')).toBeNull();
    cleanup();

    mockRegistration({ token: 'reg-jwt', id: 9, username: 'newuser', pending: true });
    const { container, registerForm } = renderWithMode('request');
    const field = screen.getByPlaceholderText('Tell us why you want to join Voicaw (optional)');
    expect(field).not.toBeRequired();
    fillRegister(container, 'newuser', 'long enough password');
    fireEvent.change(field, { target: { value: '  My friends are here ' } });
    fireEvent.submit(registerForm);
    await screen.findByLabelText('Recovery code');
    expect(api.post.mock.calls.find(([url]) => url === '/initiateregister')[1].reason).toBe('My friends are here');
    expect(api.post.mock.calls.find(([url]) => url === '/finaliseregister')[1].reason).toBe('My friends are here');
  });

  it('needs a reason when admins say so, unless an invite skips the wait', () => {
    const { container } = renderWithMode('request', {}, 'required');
    const field = screen.getByPlaceholderText('Tell us why you want to join Voicaw');
    expect(field).toBeRequired();
    fireEvent.change(container.querySelector('input[name="invite"]'), { target: { value: 'Code123' } });
    expect(field).not.toBeRequired();
  });

  it("says when the server wants a reason", async () => {
    opaque.client.startRegistration.mockReturnValue({ clientRegistrationState: 'CRS', registrationRequest: 'RR' });
    api.post.mockRejectedValue({ response: { status: 400, data: { error: 'nope', code: 'reason_required' } } });
    const { container, registerForm } = renderWithMode('request');
    fillRegister(container, 'newuser', 'long enough password');
    fireEvent.submit(registerForm);
    expect(await screen.findByRole('alert')).toHaveTextContent('Tell us why you want to join Voicaw.');
  });

  it("says when an invite doesn't work", async () => {
    opaque.client.startRegistration.mockReturnValue({ clientRegistrationState: 'CRS', registrationRequest: 'RR' });
    api.post.mockRejectedValue({ response: { status: 403, data: { error: 'nope', code: 'invalid_invite' } } });
    const { container, registerForm } = renderWithMode('invite');
    fillRegister(container, 'newuser', 'long enough password');
    fireEvent.change(container.querySelector('input[name="invite"]'), { target: { value: 'bad' } });
    fireEvent.submit(registerForm);
    expect(await screen.findByRole('alert')).toHaveTextContent("That invite doesn't work");
  });

  it('enters the app as waiting for approval', async () => {
    mockRegistration({ token: 'reg-jwt', id: 9, username: 'newuser', pending: true });
    const { container, registerForm, onLoginSuccess } = renderWithMode('request');
    fillRegister(container, 'newuser', 'long enough password');
    fireEvent.submit(registerForm);
    fireEvent.click(await screen.findByLabelText("I've saved my recovery code"));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onLoginSuccess).toHaveBeenCalledWith(expect.objectContaining({ id: 9, pending: true }));
  });

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
    fireEvent.click(screen.getByRole('checkbox', { name: /I agree to the terms of use/ }));
    fireEvent.submit(registerForm);

    // The recovery code is shown, and it only goes on once the user says it's saved.
    expect(await screen.findByLabelText('Recovery code')).toHaveTextContent('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
    const next = screen.getByRole('button', { name: 'Continue' });
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I've saved my recovery code"));
    fireEvent.click(next);
    expect(onLoginSuccess).toHaveBeenCalledWith({ token: 'reg-jwt', id: 9, username: 'newuser', hasRecoveryCode: true, pending: false, termsAccepted: true });

    expect(wrapKeyBackup).toHaveBeenCalledWith('EXPORT-KEY', KEYS);
    const [, body] = api.post.mock.calls.find(([url]) => url === '/finaliseregister');
    expect(body).toEqual({
      registrationRecord: 'REC', userIdentifier: 'newuser', ...PUBLIC, keyBackup: 'BACKUP',
      recoveryVerifier: 'REC-VERIFIER', recoveryBackup: 'REC-BACKUP', acceptedTerms: '2026-10-05',
    });
    expect(JSON.stringify(body)).not.toContain('AAAAA');
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
    fireEvent.click(screen.getByRole('checkbox', { name: /I agree to the terms of use/ }));
    fireEvent.submit(registerForm);

    fireEvent.click(await screen.findByLabelText("I've saved my recovery code"));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
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

describe('Login - forgot password', () => {
  function fillRecover(container, { username = 'alice', code = 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', password = 'brand new password', confirm = password } = {}) {
    fireEvent.change(container.querySelector('input[name="username"]'), { target: { value: username } });
    fireEvent.change(container.querySelector('input[name="recovery-code"]'), { target: { value: code } });
    fireEvent.change(container.querySelector('input[name="new-password"]'), { target: { value: password } });
    fireEvent.change(container.querySelector('input[name="confirm-password"]'), { target: { value: confirm } });
    fireEvent.submit(container.querySelector('form'));
  }

  function openRecover() {
    const utils = renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    return utils;
  }

  const NEW_CODE = 'FFFFF-GGGGG-HHHHH-JJJJJ-KKKKK';

  function mockRecovery({ twoFactor = false } = {}) {
    opaque.client.startRegistration.mockReturnValue({ clientRegistrationState: 'CRS', registrationRequest: 'RR' });
    opaque.client.finishRegistration.mockReturnValue({ registrationRecord: 'NEW-REC', exportKey: 'NEW-EXPORT' });
    unwrapRecoveryBackup.mockResolvedValue(KEYS);
    unwrapKeyBackup.mockResolvedValue(KEYS);
    wrapKeyBackup.mockResolvedValue('NEW-BACKUP');
    generateRecoveryCode.mockReturnValueOnce(NEW_CODE);
    api.post.mockImplementation(async (url) => {
      if (url === '/recover/start') return { data: { recoveryBackup: 'REC-BACKUP', ...(twoFactor && { twoFactor: true }), ...PUBLIC } };
      if (url === '/initiateregister') return { data: { registrationResponse: 'RRESP' } };
      if (url === '/recover/finish') return { data: { token: 'rec-jwt', id: 5, username: 'alice' } };
      throw new Error(`unexpected url ${url}`);
    });
  }

  const finishCalls = () => api.post.mock.calls.filter(([url]) => url === '/recover/finish');

  it('resets the password with the recovery code, re-encrypting the keys on the device and replacing the code', async () => {
    mockRecovery();
    const { container, onLoginSuccess } = openRecover();
    fillRecover(container);

    // The new code first: nothing is changed until the user says they've kept it.
    expect(await screen.findByText(/You've used your recovery code/)).toBeInTheDocument();
    expect(container.querySelector('.recovery-code').textContent).toBe(NEW_CODE);
    expect(api.post).toHaveBeenCalledWith('/recover/start', { userIdentifier: 'alice', recoveryAuth: 'REC-AUTH' });
    expect(unwrapRecoveryBackup).toHaveBeenCalledWith('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', 'REC-BACKUP');
    expect(finishCalls()).toHaveLength(0);

    fireEvent.click(screen.getByLabelText("I've saved my recovery code"));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith({ token: 'rec-jwt', id: 5, username: 'alice', hasRecoveryCode: true, pending: false, termsAccepted: true }));

    expect(wrapKeyBackup).toHaveBeenCalledWith('NEW-EXPORT', KEYS);
    expect(wrapRecoveryBackup).toHaveBeenCalledWith(NEW_CODE, KEYS);
    expect(api.post).toHaveBeenCalledWith('/recover/finish', {
      userIdentifier: 'alice', recoveryAuth: 'REC-AUTH', registrationRecord: 'NEW-REC', keyBackup: 'NEW-BACKUP',
      recoveryVerifier: 'REC-VERIFIER', recoveryBackup: 'REC-BACKUP',
    });
    for (const [, body] of api.post.mock.calls) {
      expect(JSON.stringify(body)).not.toMatch(/PRIV|brand new password|AAAAA|FFFFF/);
    }
    expect(storeUserKeys).toHaveBeenCalledWith(5, KEYS);
    expect(localStorage.getItem('token')).toBe('rec-jwt');
  });

  it('asks for a two-factor code last, after the new code is kept', async () => {
    mockRecovery({ twoFactor: true });
    const { container, onLoginSuccess } = openRecover();
    fillRecover(container);

    fireEvent.click(await screen.findByLabelText("I've saved my recovery code"));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const field = await waitFor(() => {
      const input = container.querySelector('input[name="two-factor-code"]');
      expect(input).toBeTruthy();
      return input;
    });
    expect(finishCalls()).toHaveLength(0);

    fireEvent.change(field, { target: { value: 'abcd-efgh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password and log in' }));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/recover/finish', expect.objectContaining({ twoFactorCode: 'abcd-efgh', recoveryVerifier: 'REC-VERIFIER' }));
  });

  it('keeps the same new code when the two-factor code is refused', async () => {
    mockRecovery({ twoFactor: true });
    let refused = false;
    const ok = api.post.getMockImplementation();
    api.post.mockImplementation(async (url, body) => {
      if (url === '/recover/finish' && !refused) {
        refused = true;
        throw Object.assign(new Error('401'), { response: { status: 401, data: { error: 'Wrong two-factor code' } } });
      }
      return ok(url, body);
    });
    const { container, onLoginSuccess } = openRecover();
    fillRecover(container);
    fireEvent.click(await screen.findByLabelText("I've saved my recovery code"));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(container.querySelector('input[name="two-factor-code"]')).toBeTruthy());

    fireEvent.change(container.querySelector('input[name="two-factor-code"]'), { target: { value: '000000' } });
    fireEvent.submit(container.querySelector('form'));
    expect(await screen.findByText('Wrong two-factor code')).toBeInTheDocument();
    fireEvent.change(container.querySelector('input[name="two-factor-code"]'), { target: { value: '123456' } });
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());

    expect(generateRecoveryCode).toHaveBeenCalledTimes(1);
    expect(wrapRecoveryBackup.mock.calls.every(([code]) => code === NEW_CODE)).toBe(true);
  });

  it('shows the server refusing a wrong code', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('401'), { response: { status: 401, data: { error: 'Wrong username or recovery code' } } }));
    const { container, onLoginSuccess } = openRecover();
    fillRecover(container);
    expect(await screen.findByText('Wrong username or recovery code')).toBeInTheDocument();
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('checks the code format and that the passwords match before asking the server', async () => {
    const { container } = openRecover();
    fillRecover(container, { confirm: 'something else!' });
    expect(await screen.findByText("The new passwords don't match.")).toBeInTheDocument();
    fillRecover(container, { code: 'ABC' });
    expect(await screen.findByText(/doesn't look like a recovery code/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('goes back to the login form', () => {
    openRecover();
    fireEvent.click(screen.getByRole('button', { name: 'Back to login' }));
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument();
  });
});
