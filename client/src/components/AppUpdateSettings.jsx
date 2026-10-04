import React, { useEffect, useState } from 'react';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';
import { androidUpdateText, applyUpdate, checkForUpdates, useAppUpdate } from '../utils/appUpdate';
import { formatBytes } from '../utils/formatBytes';
import { desktop } from '../utils/desktop';
import { t } from '../i18n';

const BUILD_TIME = import.meta.env.VITE_BUILD_TIME;

// Settings card: which version this device runs, and a manual "Check for updates".
export default function AppUpdateSettings() {
  useDateFormat();
  const update = useAppUpdate();
  const { available, reloads, androidVersion } = update;
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

  const start = () => {
    if (reloads) setUpdating(true);
    applyUpdate();
  };
  const busy = updating || update.progress != null;

  let readyText = t('settings.appVersion.ready');
  if (!reloads) {
    readyText = androidUpdateText(update)
      ?? t('settings.appVersion.androidReady', { version: update.version, size: formatBytes(update.size) });
  }
  const message = available
    ? readyText
    : {
      checking: t('settings.appVersion.checking'),
      current: t('settings.appVersion.current'),
      downloading: t('settings.appVersion.downloading'),
      unsupported: desktop
        ? t('settings.appVersion.unsupportedDesktop')
        // The Android app from Google Play (the one from updates.voicaw.com updates itself).
        : androidVersion ? t('settings.appVersion.unsupportedAndroid') : t('settings.appVersion.unsupportedWeb'),
      error: t('settings.appVersion.error'),
    }[status];

  return (
    <div className="settings-card">
      <h5>{t('settings.appVersion.title')}</h5>
      {desktopVersion && <p className="app-version">{t('settings.appVersion.desktopVersion', { version: desktopVersion })}</p>}
      {androidVersion && <p className="app-version">{t('settings.appVersion.androidVersion', { version: androidVersion })}</p>}
      {BUILD_TIME && (
        <p className="app-version">{t('settings.appVersion.built', { time: formatDateTime(BUILD_TIME) })}</p>
      )}
      {message && <p className="notification-settings-status" role="status">{message}</p>}
      <div className="notification-settings-actions">
        {available ? (
          <button type="button" className="btn btn-sm btn-vc" onClick={start} disabled={busy}>
            {busy ? t('settings.appVersion.updating') : t('settings.appVersion.updateNow')}
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-secondary" onClick={check} disabled={status === 'checking'}>
            {t('settings.appVersion.check')}
          </button>
        )}
      </div>
    </div>
  );
}
