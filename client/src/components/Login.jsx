import React, { useState } from 'react';
import '../assets/css/login.css';
import '../assets/css/recovery.css';
import { connectWebSocket } from '../utils/ws-client';
import {
  MIN_PASSWORD_LENGTH, logIn, register, recoverAccount, generateRecoveryCode, saveRecoveryCode,
} from '../services/authService';
import RecoveryCodeDisplay from './RecoveryCodeDisplay';

export default function Login({ onLoginSuccess }) {
  const [loginData, setLoginData] = useState({ username: '', password: '' });
  const [registerData, setRegisterData] = useState({ username: '', password: '' });
  const [recoverData, setRecoverData] = useState({ username: '', code: '', password: '', confirm: '' });
  // 'login' (log in or register), 'recover' (forgot password), or { user, recoveryCode,
  // password? } while a new code is shown: after registering (already stored), or after
  // logging in to an account without one (`password` set: stored once the user continues).
  const [mode, setMode] = useState('login');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const switchTo = (next) => {
    setError('');
    setMode(next);
  };

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await logIn(loginData.username, loginData.password);
      // Accounts from before recovery codes get one now.
      if (!user.hasRecoveryCode) {
        setMode({ user, recoveryCode: generateRecoveryCode(), password: loginData.password });
        return;
      }
      enterApp(user);
    } catch (err) {
      setError(err.message);
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  }

  function enterApp(user) {
    // Push notifications are set up after login (Layout re-syncs the subscription;
    // asking for permission needs a tap, see NotificationPrompt / Settings).
    connectWebSocket();
    onLoginSuccess(user);
  }

  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { user, recoveryCode } = await register(registerData.username, registerData.password);
      setMode({ user, recoveryCode });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRecover(e) {
    e.preventDefault();
    setError('');
    if (recoverData.password !== recoverData.confirm) {
      setError("The new passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      enterApp(await recoverAccount(recoverData.username, recoverData.code, recoverData.password));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function finishRecoveryCode() {
    if (mode.password) {
      await saveRecoveryCode(mode.user.username, mode.password, mode.recoveryCode);
      enterApp({ ...mode.user, hasRecoveryCode: true });
    } else if (mode.user) onLoginSuccess(mode.user);
    else {
      alert('Registered! You can now log in.');
      switchTo('login');
    }
  }

  if (mode.recoveryCode) {
    return (
      <div className="login-page">
        <div className="form-container">
          <h3 className="login-header text-center mb-3">Save your recovery code</h3>
          <RecoveryCodeDisplay
            code={mode.recoveryCode}
            username={mode.user?.username ?? registerData.username}
            intro={mode.password && "Your account doesn't have a recovery code yet, so here's one."}
            onDone={finishRecoveryCode}
            onSkip={mode.password ? () => enterApp(mode.user) : undefined}
          />
        </div>
      </div>
    );
  }

  if (mode === 'recover') {
    return (
      <div className="login-page">
        <div className="form-container">
          <h3 className="login-header text-center mb-3">Reset your password</h3>
          <p className="register-password-hint">
            Enter the recovery code you saved when you made your account (or in Settings), and
            choose a new password. Your messages stay.
          </p>

          {error && <div className="login-error" role="alert">{error}</div>}

          <form onSubmit={handleRecover} className="mb-3">
            <input
              name="username"
              className="form-control mb-2"
              placeholder="Username"
              autoComplete="username"
              required
              value={recoverData.username}
              onChange={e => setRecoverData({ ...recoverData, username: e.target.value })}
            />
            <input
              name="recovery-code"
              className="form-control mb-2"
              placeholder="Recovery code (XXXXX-XXXXX-…)"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              value={recoverData.code}
              onChange={e => setRecoverData({ ...recoverData, code: e.target.value })}
            />
            <input
              type="password"
              name="new-password"
              className="form-control mb-2"
              placeholder="New password"
              autoComplete="new-password"
              required
              value={recoverData.password}
              onChange={e => setRecoverData({ ...recoverData, password: e.target.value })}
            />
            <input
              type="password"
              name="confirm-password"
              className="form-control mb-2"
              placeholder="New password again"
              autoComplete="new-password"
              required
              value={recoverData.confirm}
              onChange={e => setRecoverData({ ...recoverData, confirm: e.target.value })}
            />
            <button className="btn btn-vc w-100" type="submit" disabled={loading}>
              {loading ? "Please wait..." : "Reset password and log in"}
            </button>
          </form>
          <button type="button" className="link-button" onClick={() => switchTo('login')}>
            Back to login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="form-container">
        <h3 className="login-header text-center mb-3">Voicaw Login</h3>

        {error && <div className="login-error" role="alert">{error}</div>}

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
          <button className="btn btn-vc w-100" type="submit" disabled={loading}>
            {loading ? "Please wait..." : "Login"}
          </button>
          <button type="button" className="link-button mt-2" onClick={() => switchTo('recover')}>
            Forgot password?
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
            At least {MIN_PASSWORD_LENGTH} characters. You'll get a recovery code next: keep it safe,
            it's the only way to reset a forgotten password.
          </p>
          <button className="btn btn-secondary w-100" type="submit" disabled={loading}>
            {loading ? "Please wait..." : "Register"}
          </button>
        </form>
      </div>
    </div>
  );
}
