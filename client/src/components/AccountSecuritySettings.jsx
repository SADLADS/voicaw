import React, { useState } from 'react';
import '../assets/css/recovery.css';
import { useAuth } from '../hooks/useAuth';
import { MIN_PASSWORD_LENGTH, changePassword, createRecoveryCode } from '../services/authService';
import RecoveryCodeDisplay from './RecoveryCodeDisplay';

// Settings: change password, and make a (new) recovery code. Both need the current
// password, since that's what unlocks the encryption keys to re-encrypt them.
export default function AccountSecuritySettings() {
  const { user, setUser } = useAuth();
  return (
    <div className="settings-card" id="account-security">
      <h5>Password</h5>
      <ChangePassword username={user.username} />
      <h5>Recovery code</h5>
      <RecoveryCode user={user} onCreated={() => setUser({ ...user, hasRecoveryCode: true })} />
    </div>
  );
}

function ChangePassword({ username }) {
  const [form, setForm] = useState({ current: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const field = (name) => ({ value: form[name], onChange: (e) => setForm({ ...form, [name]: e.target.value }) });

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (form.password !== form.confirm) {
      setError("The new passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await changePassword(username, form.current, form.password);
      setForm({ current: '', password: '', confirm: '' });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="account-security-form" onSubmit={submit} aria-label="Change password">
      <input type="password" className="form-control" placeholder="Current password" autoComplete="current-password" required {...field('current')} />
      <input type="password" className="form-control" placeholder="New password" autoComplete="new-password" required {...field('password')} />
      <input type="password" className="form-control" placeholder="New password again" autoComplete="new-password" required {...field('confirm')} />
      <p className="recovery-hint">At least {MIN_PASSWORD_LENGTH} characters. Your other devices stay logged in.</p>
      <button type="submit" className="btn btn-sm btn-vc" disabled={busy}>{busy ? 'Please wait…' : 'Change password'}</button>
      {error && <p className="error-msg" role="alert">{error}</p>}
      {done && <p className="account-security-success">Password changed.</p>}
    </form>
  );
}

function RecoveryCode({ user, onCreated }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [code, setCode] = useState(null);

  if (code) {
    return (
      <div className="recovery-code-panel">
        <RecoveryCodeDisplay code={code} username={user.username} doneLabel="Done" onDone={() => setCode(null)} />
      </div>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const created = await createRecoveryCode(user.username, password);
      setPassword('');
      setAsking(false);
      setCode(created);
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="account-security-form">
      <p className="recovery-hint">
        {user.hasRecoveryCode
          ? "You have a recovery code. If you've lost it, make a new one: the old one stops working."
          : "You don't have a recovery code yet. Without one, a forgotten password means losing your account and messages."}
      </p>
      {asking ? (
        <form onSubmit={submit} aria-label="Make a recovery code">
          <input
            type="password"
            className="form-control"
            placeholder="Your password"
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-vc" disabled={busy}>{busy ? 'Please wait…' : 'Show my new code'}</button>
          {' '}
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setAsking(false); setError(null); }}>Cancel</button>
          {error && <p className="error-msg" role="alert">{error}</p>}
        </form>
      ) : (
        <button type="button" className="btn btn-sm btn-vc" onClick={() => setAsking(true)}>
          {user.hasRecoveryCode ? 'Make a new recovery code' : 'Set up a recovery code'}
        </button>
      )}
    </div>
  );
}
