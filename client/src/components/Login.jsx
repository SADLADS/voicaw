import React, { useState } from 'react';
import '../assets/css/login.css';
import api from '../utils/api';

export default function Login({ onLoginSuccess }) {
  const [loginData, setLoginData] = useState({ username: '', password: '' });
  const [registerData, setRegisterData] = useState({ username: '', password: '' });
  const [error, setError] = useState('');

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    try {
      const { data } = await api.post('/login', loginData);
      if (data.error) throw new Error(data.error || 'Login failed');

      if (data.token) {
        localStorage.setItem('token', data.token); // Save JWT
        onLoginSuccess(data); // Pass user info to parent
      } else {
        throw new Error('No token received');
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    try {
      const { data } = await api.post('/register', registerData);
      if (data.error) throw new Error(data.error || 'Registration failed');

      if (data.token) {
        localStorage.setItem('token', data.token); // Save JWT
        onLoginSuccess(data); // Optionally auto-login after register
      } else {
        alert('Registered! You can now log in.');
      }
    } catch (err) {
      setError(err.message);
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
        <button className="btn btn-vc w-100" type="submit">Login</button>
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
        <button className="btn btn-secondary w-100" type="submit">Register</button>
      </form>
    </div>
  );
}
