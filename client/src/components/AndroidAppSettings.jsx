import React, { useEffect, useState } from 'react';
import { android, androidNotificationState, refreshAndroidNotificationState } from '../utils/android';
import { formatDateTime } from '../utils/dateFormat';
import { t } from '../i18n';

// Settings → Android App (only in the Android app): whether calls may ring over the lock
// screen (Android 14+ lets people turn that off), and Android's own notification settings
// (each kind of notification is a channel there, with its own sound).
export default function AndroidAppSettings() {
  const [state, setState] = useState(androidNotificationState);

  // Read again on return from Android's settings.
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) refreshAndroidNotificationState().then((next) => setState({ ...next }));
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, []);

  const open = (which) => android.openSettings({ which }).catch((err) => console.warn('Could not open settings', err));

  return (
    <div className="settings-card">
      <h5 id="settings-android-app">{t('settings.androidApp.title')}</h5>
      {!state.push && <p className="vc-hint" role="status">{t('settings.androidApp.noPush')}</p>}
      <h6 id="settings-lock-screen-calls">{t('settings.androidApp.lockScreenCalls')}</h6>
      <p className="vc-hint">
        {state.fullScreen ? t('settings.androidApp.lockScreenCallsOn') : t('settings.androidApp.lockScreenCallsOff')}
      </p>
      {!state.fullScreen && (
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => open('fullScreen')}>
          {t('settings.androidApp.allowLockScreenCalls')}
        </button>
      )}
      <h6 id="settings-notification-channels" className="mt-3">{t('settings.androidApp.channels')}</h6>
      <p className="vc-hint">{t('settings.androidApp.channelsHint')}</p>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => open('notifications')}>
        {t('settings.androidApp.openChannels')}
      </button>
      <PushLog />
    </div>
  );
}

// What became of the last pushes this phone got (mobile/.../PushLog.java), to see where a
// notification that never showed got stuck: no messages or names, only times and outcomes.
function PushLog() {
  const [entries, setEntries] = useState(null);
  const refresh = () => android.getPushLog()
    .then(({ entries: list }) => setEntries(list))
    .catch((err) => console.warn('Could not read the push log', err));
  useEffect(() => {
    refresh();
  }, []);

  return (
    <>
      <h6 id="settings-push-log" className="mt-3">{t('settings.androidApp.pushLog')}</h6>
      <p className="vc-hint">{t('settings.androidApp.pushLogHint')}</p>
      {entries && entries.length === 0 && <p className="vc-hint">{t('settings.androidApp.pushLogEmpty')}</p>}
      {entries && entries.length > 0 && (
        <ul className="android-push-log">
          {entries.map((entry) => (
            <li key={`${entry.at}-${entry.type}-${entry.outcome}`}>
              <span className="android-push-log-time">{formatDateTime(entry.at)}</span>
              {' '}{entry.type || '?'}: {entry.outcome}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn-sm btn-secondary" onClick={refresh}>
        {t('settings.androidApp.pushLogRefresh')}
      </button>
    </>
  );
}
