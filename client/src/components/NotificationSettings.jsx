import React, { useContext, useEffect, useState } from 'react';
import { ConfigContext } from '../contexts';
import {
  disableNotificationsOnThisDevice,
  enableNotifications,
  ensureSubscription,
  getPushStatus,
  sendTestNotification,
} from '../services/pushService';
import { isDesktopApp } from '../utils/desktop';
import { t } from '../i18n';

const STATUS_TEXT = {
  granted: 'settings.notifications.status.granted',
  off: 'settings.notifications.status.off',
  'can-enable': 'settings.notifications.status.off',
  denied: 'settings.notifications.status.denied',
  'needs-install': 'settings.notifications.status.needsInstall',
  unsupported: 'settings.notifications.status.unsupported',
};

export default function NotificationSettings() {
  const { vapidPublicKey } = useContext(ConfigContext);
  const [status, setStatus] = useState(getPushStatus);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  // Browser permission alone doesn't mean this device is registered with the server for
  // this account, so when notifications look "on", make sure (and show it if that fails).
  const [registrationError, setRegistrationError] = useState(null);

  useEffect(() => {
    if (status !== 'granted' || !vapidPublicKey) return;
    let cancelled = false;
    ensureSubscription(vapidPublicKey).then(
      () => { if (!cancelled) setRegistrationError(null); },
      (err) => {
        console.error('Could not register this device for notifications:', err);
        if (!cancelled) setRegistrationError(err.message || String(err));
      }
    );
    return () => { cancelled = true; };
  }, [status, vapidPublicKey]);

  const run = async (fn) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      console.error(err);
      setMessage(t('settings.notifications.somethingWentWrong', { error: err.message }));
    } finally {
      setStatus(getPushStatus());
      setBusy(false);
    }
  };

  // enableNotifications must be the first thing awaited in the click (iOS gesture rule).
  const turnOn = () => run(async () => {
    await enableNotifications(vapidPublicKey);
    setRegistrationError(null);
  });
  const turnOff = () => run(() => disableNotificationsOnThisDevice({ remember: true }));
  const test = () => run(async () => {
    const { devices, delivered } = await sendTestNotification();
    if (devices === 0) setMessage(t('settings.notifications.test.noDevices'));
    else if (delivered === devices) setMessage(t('settings.notifications.test.sent', { count: devices }));
    else setMessage(t('settings.notifications.test.partlySent', { delivered, count: devices }));
  });

  return (
    <div className="settings-card">
      <h5>{t('settings.notifications.title')}</h5>
      <p className="notification-settings-status">
        {status === 'granted' && registrationError
          ? t('settings.notifications.registrationFailed', { error: registrationError })
          : STATUS_TEXT[status] && t(STATUS_TEXT[status])}
        {status === 'granted' && isDesktopApp() && ` ${t('settings.notifications.desktopNote')}`}
      </p>

      <div className="notification-settings-actions">
        {(status === 'can-enable' || status === 'off') && (
          <button type="button" className="uploadbutton btn" onClick={turnOn} disabled={busy}>
            {t('settings.notifications.turnOn')}
          </button>
        )}
        {status === 'granted' && registrationError && (
          <button type="button" className="uploadbutton btn" onClick={turnOn} disabled={busy}>
            {t('settings.notifications.tryAgain')}
          </button>
        )}
        {status === 'granted' && (
          <>
            <button type="button" className="btn btn-sm btn-secondary" onClick={turnOff} disabled={busy}>
              {t('settings.notifications.turnOff')}
            </button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={test} disabled={busy}>
              {t('settings.notifications.sendTest')}
            </button>
          </>
        )}
      </div>

      {message && <p className="notification-settings-message">{message}</p>}
    </div>
  );
}
