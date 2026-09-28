import React, { useState } from 'react';
import '../assets/css/login.css';
import api from '../utils/api';
import * as opaque from "@serenity-kit/opaque";
import { generateUserKeys, wrapKeyBackup, unwrapKeyBackup } from '../services/encryptionService';
import { connectWebSocket } from "../utils/ws-client"
import { storeUserKeys } from '../services/keyStore';

// The password is what the encryption keys are protected with (and it can't be reset), so
// insist on a reasonable length. The server never sees it, so it can only be checked here.
export const MIN_PASSWORD_LENGTH = 10;

const PUBLIC_KEY_FIELDS = ['identityKey', 'encryptionKey', 'encryptionKeySignature'];

export default function Login({ onLoginSuccess }) {
  const [loginData, setLoginData] = useState({ username: '', password: '' });
  const [registerData, setRegisterData] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [Loading, setLoading] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const password = loginData.password;
      const username = loginData.username;
      if (!username || !password) {
        throw new Error('Username and password are required');
      }
      const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
        password,
      });

      // clientLoginState is this device's secret half of the OPAQUE exchange: never send it.
      const response1 = await api.post('/initiatelogin', { startLoginRequest, userIdentifier: username });
      const loginResponse = response1.data.loginResponse;
      const loginResult = opaque.client.finishLogin({
        clientLoginState,
        loginResponse,
        password,
      });
      if (!loginResult) {
        // Wrong password and unknown username look the same here (on purpose).
        throw new Error("Incorrect username or password");
      }
      const { finishLoginRequest, sessionKey, exportKey } = loginResult;

      const response2 = await api.post('/finaliselogin', { finishLoginRequest, clientSessionKey: sessionKey, userIdentifier: username });
      const { token, id, keyBackup } = response2.data;
      if (!token || !keyBackup) throw new Error('Login failed');

      // The keys are encrypted with OPAQUE's exportKey, which only this password produces.
      let keys;
      try {
        keys = await unwrapKeyBackup(exportKey, keyBackup);
      } catch {
        throw new Error("Couldn't unlock your encryption keys.");
      }
      // The server must publish exactly the public keys in our own backup; otherwise
      // other people would be encrypting to keys that aren't ours.
      if (PUBLIC_KEY_FIELDS.some((field) => keys.public[field] !== response2.data[field])) {
        throw new Error("The server's copy of your public keys doesn't match your account. Not logging in.");
      }

      await storeUserKeys(id, keys);
      localStorage.setItem('token', token);

      // Push notifications are set up after login (Layout re-syncs the subscription;
      // asking for permission needs a tap, see NotificationPrompt / Settings).
      connectWebSocket();
      onLoginSuccess({ token, id, username: response2.data.username });
    } catch (err) {
      setError(err.message);
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const password = registerData.password;
      const username = registerData.username;
      if (!username || !password) {
        throw new Error('Username and password are required');
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });

      const response1 = await api.post('/initiateregister', { userIdentifier: username, registrationRequest });
      if (response1.data.error) throw new Error(response1.data.error || 'Registration failed');
      const { registrationRecord, exportKey } = opaque.client.finishRegistration({
        clientRegistrationState,
        registrationResponse: response1.data.registrationResponse,
        password,
      });

      // New keys, backed up on the server encrypted with the OPAQUE exportKey.
      const keys = await generateUserKeys();
      const keyBackup = await wrapKeyBackup(exportKey, keys);

      const response2 = await api.post('/finaliseregister', {
        registrationRecord,
        userIdentifier: username,
        ...keys.public,
        keyBackup,
      });

      if (response2.data.token) {
        await storeUserKeys(response2.data.id, keys);
        localStorage.setItem('token', response2.data.token);
        onLoginSuccess(response2.data);
      } else {
        alert('Registered! You can now log in.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }






  return (
    <div className="form-container">
      <h3 className="login-header text-center mb-3">Voicaw Login</h3>

      {error && <div style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}

      <form onSubmit={handleLogin} className="mb-3">
        <input
          name="username"
          className="form-control mb-2"
          placeholder="Username"
          required
          value={loginData.username}
          onChange={e => setLoginData({ ...loginData, username: e.target.value })}
        />
        <input
          type="password"
          name="password"
          className="form-control mb-2"
          placeholder="Password"
          required
          value={loginData.password}
          onChange={e => setLoginData({ ...loginData, password: e.target.value })}
        />
        <button className="btn btn-vc w-100" type="submit" disabled={Loading}>
          {Loading ? "Please wait..." : "Login"}
        </button>
      </form>

      <hr />

      <form onSubmit={handleRegister}>
        <input
          name="username"
          className="form-control mb-2"
          placeholder="New Username"
          required
          value={registerData.username}
          onChange={e => setRegisterData({ ...registerData, username: e.target.value })}
        />
        <input
          type="password"
          name="password"
          className="form-control mb-2"
          placeholder="New Password"
          required
          value={registerData.password}
          onChange={e => setRegisterData({ ...registerData, password: e.target.value })}
        />
        <p className="register-password-hint">
          At least {MIN_PASSWORD_LENGTH} characters. Your password protects your encrypted messages and
          can't be reset: if you forget it, your message history can't be recovered.
        </p>
        <button className="btn btn-secondary w-100" type="submit" disabled={Loading}>
          {Loading ? "Please wait..." : "Register"}
        </button>
      </form>
    </div>
  );
}
