import React, { useState } from 'react';
import '../assets/css/login.css';
import { connectWebSocket } from '../utils/ws-client';
import { MIN_PASSWORD_LENGTH, logIn, register } from '../services/authService';

export default function Login({ onLoginSuccess }) {
  const [loginData, setLoginData] = useState({ username: '', password: '' });
  const [registerData, setRegisterData] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await logIn(loginData.username, loginData.password);
      // Push notifications are set up after login (Layout re-syncs the subscription;
      // asking for permission needs a tap, see NotificationPrompt / Settings).
      connectWebSocket();
      onLoginSuccess(user);
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
      const user = await register(registerData.username, registerData.password);
      if (user) onLoginSuccess(user);
      else alert('Registered! You can now log in.');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
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
          <button className="btn btn-secondary w-100" type="submit" disabled={loading}>
            {loading ? "Please wait..." : "Register"}
          </button>
        </form>
      </div>
    </div>
  );
}
