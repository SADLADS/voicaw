import React, { useEffect, useState } from 'react';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';
import { applyUpdate, checkForUpdates, useAppUpdate } from '../utils/appUpdate';
import { desktop } from '../utils/desktop';

const BUILD_TIME = import.meta.env.VITE_BUILD_TIME;

// Settings card: which version this device runs, and a manual "Check for updates".
export default function AppUpdateSettings() {
  useDateFormat();
  const { available } = useAppUpdate();
  const [status, setStatus] = useState(null); // 'checking' | 'current' | 'unsupported' | 'error'
  const [updating, setUpdating] = useState(false);
  // The desktop app's own version (it ships its page).
  const [desktopVersion, setDesktopVersion] = useState(null);
  useEffect(() => {
    desktop?.getInfo().then((info) => setDesktopVersion(info?.version ?? null)).catch(() => {});
  }, []);

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
      downloading: 'Downloading a new version… It will be offered here once it’s ready.',
      unsupported: desktop
        ? "This copy of the app can't update itself. Download the latest version from the website."
        : "This app can't update itself here. Reload the page to get the latest version.",
      error: "Couldn't check for updates. Are you online?",
    }[status];

  return (
    <div className="settings-card">
      <h5>App Version</h5>
      {desktopVersion && <p className="app-version">Desktop app {desktopVersion}</p>}
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
