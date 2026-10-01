import React, { useContext, useEffect, useState } from 'react';
import { ConfigContext } from '../contexts';
import {
  disableNotificationsOnThisDevice,
  enableNotifications,
  ensureSubscription,
  getPushStatus,
  sendTestNotification,
} from '../services/pushService';
import { getSetting, setSetting } from '../services/settingsStore';
import { isDesktopApp } from '../utils/desktop';

const STATUS_TEXT = {
  granted: 'Notifications are on for this device.',
  off: 'Notifications are off for this device.',
  'can-enable': 'Notifications are off for this device.',
  denied: 'Notifications are blocked for Voicaw in this browser\'s settings. Allow them there, then reload.',
  'needs-install': 'On iPhone and iPad, notifications only work from the Home Screen app: tap Share → "Add to Home Screen", then open Voicaw from your Home Screen.',
  unsupported: 'This browser doesn\'t support notifications.',
};

export default function NotificationSettings() {
  const { vapidPublicKey } = useContext(ConfigContext);
  const [status, setStatus] = useState(getPushStatus);
  const [previews, setPreviews] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  // Browser permission alone doesn't mean this device is registered with the server for
  // this account, so when notifications look "on", make sure (and show it if that fails).
  const [registrationError, setRegistrationError] = useState(null);

  useEffect(() => {
    getSetting('notificationPreviews').then(setPreviews);
  }, []);

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
      setMessage(`Something went wrong: ${err.message}`);
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
    const plural = (n) => `${n} device${n === 1 ? '' : 's'}`;
    if (devices === 0) setMessage('No devices are set up for notifications on this account yet.');
    else if (delivered === devices) setMessage(`Sent to ${plural(devices)}.`);
    else setMessage(`Sent to ${delivered} of ${plural(devices)}; the rest couldn't be reached.`);
  });
  const togglePreviews = async (e) => {
    const value = e.target.checked;
    setPreviews(value);
    await setSetting('notificationPreviews', value);
  };

  return (
    <div className="settings-card">
      <h5>Notifications</h5>
      <p className="notification-settings-status">
        {status === 'granted' && registrationError
          ? `Notifications are allowed, but this device couldn't be registered: ${registrationError}`
          : STATUS_TEXT[status]}
        {status === 'granted' && isDesktopApp() && ' They arrive while the app is running, in the tray too.'}
      </p>

      <div className="notification-settings-actions">
        {(status === 'can-enable' || status === 'off') && (
          <button type="button" className="uploadbutton btn" onClick={turnOn} disabled={busy}>
            Turn on
          </button>
        )}
        {status === 'granted' && registrationError && (
          <button type="button" className="uploadbutton btn" onClick={turnOn} disabled={busy}>
            Try again
          </button>
        )}
        {status === 'granted' && (
          <>
            <button type="button" className="btn btn-sm btn-secondary" onClick={turnOff} disabled={busy}>
              Turn off
            </button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={test} disabled={busy}>
              Send test notification
            </button>
          </>
        )}
      </div>

      {status === 'granted' && (
        <label className="notification-settings-previews">
          <input type="checkbox" checked={previews} onChange={togglePreviews} />
          {' '}Show message text in notifications
        </label>
      )}

      {message && <p className="notification-settings-message">{message}</p>}
    </div>
  );
}
