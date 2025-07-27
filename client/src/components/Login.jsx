import React, { useState } from 'react';
import '../assets/css/login.css';

export default function Login({ onLoginSuccess }) {
  const [loginData, setLoginData] = useState({ username: '', password: '' });
  const [registerData, setRegisterData] = useState({ username: '', password: '' });
  const [error, setError] = useState('');

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginData),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      onLoginSuccess(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registerData),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      alert('Registered! You can now log in.');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="form-container">
      <h3 className="login-header text-center mb-3">Voicaw Login</h3>

      {error && <div style={{color:'red', marginBottom:'1rem'}}>{error}</div>}

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
