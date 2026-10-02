import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDesktop, faMobileScreenButton, faLaptop } from '@fortawesome/free-solid-svg-icons';
import api from '../utils/api';
import { describeDevice } from '../utils/deviceName';
import { formatDate, formatDateTime, useDateFormat } from '../utils/dateFormat';
import ConfirmDialog from './guild/ConfirmDialog';

const ICONS = { desktop: faLaptop, mobile: faMobileScreenButton, app: faDesktop };

function errorText(err, fallback) {
  return err.response?.data?.error || fallback;
}

function DeviceRow({ session, onLogOut, busy }) {
  const { name, kind } = describeDevice(session.user_agent);
  let seen;
  if (session.current) seen = 'This device';
  else if (session.online) seen = 'Online now';
  else seen = `Last active ${formatDateTime(session.last_used_at * 1000)}`;
  return (
    <li className="device-row" data-current={session.current || undefined}>
      <FontAwesomeIcon icon={ICONS[kind]} className="device-icon" fixedWidth />
      <div className="device-info">
        <div className="device-name">{name}</div>
        <div className="device-details">
          <span className={session.current || session.online ? 'device-online' : undefined}>{seen}</span>
          {session.ip && <> · {session.ip}</>}
          {' · '}Logged in {formatDate(session.created_at * 1000)}
        </div>
      </div>
      {!session.current && (
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => onLogOut(session)}>
          Log out
        </button>
      )}
    </li>
  );
}

// Settings → Devices: every device logged in to this account (server/sessions.js), and
// logging one, or every other one, out. A device logged out here can't use its login any
// more and goes back to the login page.
export default function DeviceSettings() {
  useDateFormat();
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/sessions')
      .then(({ data }) => { if (!cancelled) setSessions(data); })
      .catch((err) => { if (!cancelled) setError(errorText(err, "Couldn't load your devices")); });
    return () => { cancelled = true; };
  }, []);

  const logOut = async (session) => {
    setBusy(true);
    setError(null);
    try {
      setSessions((await api.delete(`/sessions/${encodeURIComponent(session.id)}`)).data);
    } catch (err) {
      setError(errorText(err, "Couldn't log that device out"));
    } finally {
      setBusy(false);
    }
  };

  const others = sessions?.filter((s) => !s.current) ?? [];

  return (
    <div className="settings-card">
      <h5>Devices</h5>
      <p className="admin-setting-help">
        Where you&apos;re logged in. If you don&apos;t recognise one, log it out and change your password.
      </p>
      {sessions === null && !error && <p className="admin-setting-help">Loading…</p>}
      {sessions && (
        <ul className="device-list">
          {sessions.map((s) => <DeviceRow key={s.id} session={s} onLogOut={logOut} busy={busy} />)}
        </ul>
      )}
      {others.length > 0 && (
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirmAll(true)}>
          Log out all other devices
        </button>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}
      {confirmAll && (
        <ConfirmDialog
          title="Log out all other devices?"
          message={`${others.length === 1 ? 'The other device' : `All ${others.length} other devices`} will have to log in again. This one stays logged in.`}
          confirmLabel="Log out"
          focusConfirm
          onConfirm={async () => setSessions((await api.delete('/sessions')).data)}
          onClose={() => setConfirmAll(false)}
        />
      )}
    </div>
  );
}
