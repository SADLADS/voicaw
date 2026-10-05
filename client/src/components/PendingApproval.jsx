import React, { useEffect, useRef, useState } from 'react';
import '../assets/css/login.css';
import api from '../utils/api';
import { connectWebSocket, onAccountApproved } from '../utils/ws-client';
import { deleteAccount } from '../services/authService';
import { t } from '../i18n';

// How often the page asks whether the account was approved, in case the websocket missed it.
const CHECK_MS = 60 * 1000;

// What an account waiting for an admin's approval sees instead of the app (server/signups.js):
// it opens by itself once approved (`onApproved`). Until then: log out, or withdraw the request,
// which deletes the account (nothing of it is kept). Declining logs it out (the websocket says
// so, like a deleted account).
export default function PendingApproval({ user, onApproved, onLogout }) {
  const [withdrawing, setWithdrawing] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const onApprovedRef = useRef(onApproved);
  onApprovedRef.current = onApproved;

  useEffect(() => {
    connectWebSocket();
    const approved = () => onApprovedRef.current();
    const off = onAccountApproved(approved);
    const timer = setInterval(async () => {
      try {
        const { data } = await api.get('/profile');
        if (data?.id && !data.pending) approved();
      } catch {
        // Offline, or declined meanwhile (the websocket logs out then).
      }
    }, CHECK_MS);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);

  const withdraw = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await deleteAccount(user, password);
    } catch (err) {
      setError(err.message);
      setBusy(false);
      return;
    }
    onLogout();
  };

  return (
    <div className="login-page">
      <div className="form-container pending-approval">
        <h3 className="login-header text-center mb-3">{t('auth.pending.title')}</h3>
        <p>{t('auth.pending.body', { username: user.username })}</p>
        <p className="register-password-hint">{t('auth.pending.opensByItself')}</p>
        <button type="button" className="btn btn-vc w-100 mb-3" onClick={onLogout}>
          {t('auth.pending.logOut')}
        </button>
        {!withdrawing ? (
          <button type="button" className="link-button" onClick={() => setWithdrawing(true)}>
            {t('auth.pending.withdraw')}
          </button>
        ) : (
          <form onSubmit={withdraw}>
            <p className="register-password-hint">{t('auth.pending.withdrawHint')}</p>
            <input
              type="password"
              name="password"
              className="form-control mb-2"
              placeholder={t('auth.password')}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <div className="login-error" role="alert">{error}</div>}
            <button type="submit" className="btn btn-danger w-100 mb-2" disabled={busy || !password}>
              {busy ? t('auth.pleaseWait') : t('auth.pending.withdrawSubmit')}
            </button>
            <button type="button" className="link-button" onClick={() => { setWithdrawing(false); setPassword(''); setError(null); }}>
              {t('common.cancel')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
