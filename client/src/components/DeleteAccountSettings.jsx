import React, { useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import '../assets/css/recovery.css';
import { useAuth } from '../hooks/useAuth';
import { LayoutContext } from '../contexts';
import { deleteAccount } from '../services/authService';

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
      <h5>Delete Account</h5>
      {!asking ? (
        <div className="account-security-form">
          <p className="recovery-hint">
            Deletes your account for good. Your messages stay, shown as from “Deleted User”.
          </p>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setAsking(true)}>Delete account</button>
        </div>
      ) : (
        <form className="account-security-form delete-account-form" onSubmit={submit} aria-label="Delete account">
          <p>This can’t be undone. Once your account is deleted:</p>
          <ul className="delete-account-list">
            <li>You’re logged out everywhere and can’t log in again. Your username becomes free for anyone.</li>
            <li>Your messages in chats, groups and guilds stay, shown as from “Deleted User”. Your notes are deleted.</li>
            <li>You leave every guild and group DM. People you talked to can still read your conversations, but not reply.</li>
          </ul>
          {owned.length > 0 && (
            <div className="delete-account-guilds" role="group" aria-label="Guilds you own">
              <p>
                You own {owned.length === 1 ? 'a guild' : `${owned.length} guilds`}. Make someone else the owner
                (Make owner on their card in the member list), or delete {owned.length === 1 ? 'it' : 'them'}:
              </p>
              <ul className="delete-account-list">
                {owned.map((g) => <li key={g.id}><Link to={`/guild/${g.id}`}>{g.name}</Link></li>)}
              </ul>
              <label className="recovery-confirm">
                <input type="checkbox" checked={deleteGuilds} onChange={(e) => setDeleteGuilds(e.target.checked)} />
                {' '}Delete {owned.length === 1 ? 'this guild' : `these ${owned.length} guilds`} and everything in {owned.length === 1 ? 'it' : 'them'} too
              </label>
            </div>
          )}
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
          <button type="submit" className="btn btn-sm btn-danger" disabled={busy || blocked}>
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
          {' '}
          <button type="button" className="btn btn-sm btn-secondary" onClick={cancel} disabled={busy}>Cancel</button>
          {error && <p className="error-msg" role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
