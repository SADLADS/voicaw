import React, { useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import '../assets/css/recovery.css';
import { useAuth } from '../hooks/useAuth';
import { LayoutContext } from '../contexts';
import { deleteAccount } from '../services/authService';
import { t } from '../i18n';

// Settings: delete your account (server/accounts.js). Guilds you own have to be handed over
// (Make owner on a member's card) or deleted first; ticking the box deletes them along with
// the account. Needs the password. Messages stay, under "Deleted User".
export default function DeleteAccountSettings({ onDeleted }) {
  const { user } = useAuth();
  const guildList = useContext(LayoutContext)?.guildList;
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [deleteGuilds, setDeleteGuilds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // What the server said you own, when it refused (the guild list can lag behind).
  const [refusedFor, setRefusedFor] = useState(null);

  const owned = refusedFor ?? (guildList?.guilds ?? []).filter((g) => g.owner === user.id);

  const cancel = () => {
    setAsking(false);
    setPassword('');
    setDeleteGuilds(false);
    setError(null);
    setRefusedFor(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await deleteAccount(user, password, { deleteOwnedGuilds: owned.length > 0 && deleteGuilds });
    } catch (err) {
      if (err.code === 'owns_guilds') setRefusedFor(err.guilds);
      setError(err.message);
      setBusy(false);
      return;
    }
    onDeleted();
  };

  const blocked = owned.length > 0 && !deleteGuilds;

  return (
    <div className="settings-card" id="delete-account">
      <h5>{t('settings.deleteAccount.title')}</h5>
      {!asking ? (
        <div className="account-security-form">
          <p className="recovery-hint">
            {t('settings.deleteAccount.intro')}
          </p>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setAsking(true)}>{t('settings.deleteAccount.button')}</button>
        </div>
      ) : (
        <form className="account-security-form delete-account-form" onSubmit={submit} aria-label={t('settings.deleteAccount.button')}>
          <p>{t('settings.deleteAccount.warning')}</p>
          <ul className="delete-account-list">
            <li>{t('settings.deleteAccount.loggedOut')}</li>
            <li>{t('settings.deleteAccount.messagesStay')}</li>
            <li>{t('settings.deleteAccount.leaveEverything')}</li>
          </ul>
          {owned.length > 0 && (
            <div className="delete-account-guilds" role="group" aria-label={t('settings.deleteAccount.guildsYouOwn')}>
              <p>
                {t('settings.deleteAccount.ownGuilds', { count: owned.length })}
              </p>
              <ul className="delete-account-list">
                {owned.map((g) => <li key={g.id}><Link to={`/guild/${g.id}`}>{g.name}</Link></li>)}
              </ul>
              <label className="recovery-confirm">
                <input type="checkbox" checked={deleteGuilds} onChange={(e) => setDeleteGuilds(e.target.checked)} />
                {' '}{t('settings.deleteAccount.deleteGuilds', { count: owned.length })}
              </label>
            </div>
          )}
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
          <button type="submit" className="btn btn-sm btn-danger" disabled={busy || blocked}>
            {busy ? t('settings.deleteAccount.deleting') : t('settings.deleteAccount.confirm')}
          </button>
          {' '}
          <button type="button" className="btn btn-sm btn-secondary" onClick={cancel} disabled={busy}>{t('common.cancel')}</button>
          {error && <p className="error-msg" role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
