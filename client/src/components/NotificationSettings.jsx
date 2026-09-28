import React, { useContext, useEffect, useState } from 'react';
import { ConfigContext } from '../App';
import {
  disableNotificationsOnThisDevice,
  enableNotifications,
  getPushStatus,
  sendTestNotification,
} from '../services/pushService';
import { getSetting, setSetting } from '../services/settingsStore';

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

  useEffect(() => {
    getSetting('notificationPreviews').then(setPreviews);
  }, []);

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
  const turnOn = () => run(() => enableNotifications(vapidPublicKey));
  const turnOff = () => run(() => disableNotificationsOnThisDevice({ remember: true }));
  const test = () => run(async () => {
    const sent = await sendTestNotification();
    setMessage(sent > 0
      ? `Sent to ${sent} device${sent === 1 ? '' : 's'}.`
      : 'No devices are set up for notifications yet.');
  });
  const togglePreviews = async (e) => {
    const value = e.target.checked;
    setPreviews(value);
    await setSetting('notificationPreviews', value);
  };

  return (
    <div className="settings-card">
      <h5>Notifications</h5>
      <p className="notification-settings-status">{STATUS_TEXT[status]}</p>

      <div className="notification-settings-actions">
        {(status === 'can-enable' || status === 'off') && (
          <button type="button" className="uploadbutton btn" onClick={turnOn} disabled={busy}>
            Turn on
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
