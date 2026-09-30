import React, { useState } from 'react';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';
import { applyUpdate, checkForUpdates, useAppUpdate } from '../utils/appUpdate';

const BUILD_TIME = import.meta.env.VITE_BUILD_TIME;

// Settings card: which version this device runs, and a manual "Check for updates".
export default function AppUpdateSettings() {
  useDateFormat();
  const { available } = useAppUpdate();
  const [status, setStatus] = useState(null); // 'checking' | 'current' | 'unsupported' | 'error'
  const [updating, setUpdating] = useState(false);

  const check = async () => {
    setStatus('checking');
    try {
      setStatus(await checkForUpdates());
    } catch (err) {
      console.error('Update check failed', err);
      setStatus('error');
    }
  };

  const update = () => {
    setUpdating(true);
    applyUpdate();
  };

  const message = available
    ? 'A new version is ready.'
    : {
      checking: 'Checking…',
      current: "You're on the latest version.",
      unsupported: "This app can't update itself here. Reload the page to get the latest version.",
      error: "Couldn't check for updates. Are you online?",
    }[status];

  return (
    <div className="settings-card">
      <h5>App Version</h5>
      {BUILD_TIME && (
        <p className="app-version">Built {formatDateTime(BUILD_TIME)}</p>
      )}
      {message && <p className="notification-settings-status" role="status">{message}</p>}
      <div className="notification-settings-actions">
        {available ? (
          <button type="button" className="btn btn-sm btn-vc" onClick={update} disabled={updating}>
            {updating ? 'Updating…' : 'Update now'}
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-secondary" onClick={check} disabled={status === 'checking'}>
            Check for updates
          </button>
        )}
      </div>
    </div>
  );
}
