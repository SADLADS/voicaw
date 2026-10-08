import React, { useState } from 'react';
import '../assets/css/recovery.css';
import { useAuth } from '../hooks/useAuth';
import { MIN_PASSWORD_LENGTH, changePassword, createRecoveryCode } from '../services/authService';
import RecoveryCodeDisplay from './RecoveryCodeDisplay';
import { t } from '../i18n';

// Settings → My Account: change password, and make a (new) recovery code, a card each. Both
// need the current password, since that's what unlocks the encryption keys to re-encrypt them.
export function PasswordSettings() {
  const { user } = useAuth();
  return (
    <div className="settings-card">
      <h5>{t('settings.accountSecurity.passwordTitle')}</h5>
      <ChangePassword username={user.username} />
    </div>
  );
}

export function RecoveryCodeSettings() {
  const { user, setUser } = useAuth();
  return (
    <div className="settings-card">
      <h5>{t('settings.accountSecurity.recoveryCodeTitle')}</h5>
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
      setError(t('settings.accountSecurity.passwordsDontMatch'));
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
    <form className="account-security-form" onSubmit={submit} aria-label={t('settings.accountSecurity.changePassword')}>
      <input type="password" className="form-control" placeholder={t('settings.accountSecurity.currentPassword')} autoComplete="current-password" required {...field('current')} />
      <input type="password" className="form-control" placeholder={t('settings.accountSecurity.newPassword')} autoComplete="new-password" required {...field('password')} />
      <input type="password" className="form-control" placeholder={t('settings.accountSecurity.newPasswordAgain')} autoComplete="new-password" required {...field('confirm')} />
      <p className="recovery-hint">{t('settings.accountSecurity.passwordHint', { count: MIN_PASSWORD_LENGTH })}</p>
      <button type="submit" className="btn btn-sm btn-vc" disabled={busy}>{busy ? t('settings.pleaseWait') : t('settings.accountSecurity.changePassword')}</button>
      {error && <p className="error-msg" role="alert">{error}</p>}
      {done && <p className="account-security-success">{t('settings.accountSecurity.passwordChanged')}</p>}
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
        <RecoveryCodeDisplay code={code} username={user.username} doneLabel={t('common.done')} onDone={() => setCode(null)} />
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
          ? t('settings.accountSecurity.hasRecoveryCode')
          : t('settings.accountSecurity.noRecoveryCode')}
      </p>
      {asking ? (
        <form onSubmit={submit} aria-label={t('settings.accountSecurity.makeRecoveryCode')}>
          <input
            type="password"
            className="form-control"
            placeholder={t('settings.yourPassword')}
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-vc" disabled={busy}>{busy ? t('settings.pleaseWait') : t('settings.accountSecurity.showNewCode')}</button>
          {' '}
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setAsking(false); setError(null); }}>{t('common.cancel')}</button>
          {error && <p className="error-msg" role="alert">{error}</p>}
        </form>
      ) : (
        <button type="button" className="btn btn-sm btn-vc" onClick={() => setAsking(true)}>
          {user.hasRecoveryCode ? t('settings.accountSecurity.newRecoveryCode') : t('settings.accountSecurity.setUpRecoveryCode')}
        </button>
      )}
    </div>
  );
}
