import React, { useContext, useState } from 'react';
import { ConfigContext } from '../contexts';
import { enableNotifications, getPushStatus } from '../services/pushService';
import { t } from '../i18n';

const DISMISSED_KEY = 'notificationPromptDismissed';

// A one-line banner offering to turn on notifications (or, on iPhone/iPad in the browser,
// explaining they need the Home Screen app). Dismissible; Settings has the full controls.
export default function NotificationPrompt() {
  const { vapidPublicKey } = useContext(ConfigContext);
  const [status, setStatus] = useState(getPushStatus);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === status);
  const [error, setError] = useState(null);

  if (dismissed || !['can-enable', 'needs-install'].includes(status)) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, status);
    setDismissed(true);
  };

  // Called straight from the click so iOS treats the permission request as user-initiated.
  const enable = async () => {
    try {
      await enableNotifications(vapidPublicKey);
      setError(null);
    } catch (err) {
      console.error('Failed to enable notifications:', err);
      setError(t('settings.notificationPrompt.failed'));
    }
    setStatus(getPushStatus());
  };

  return (
    <div className="notification-prompt" role="region" aria-label={t('settings.notifications.title')}>
      <span>
        {error || (status === 'needs-install'
          ? t('settings.notificationPrompt.needsInstall')
          : t('settings.notificationPrompt.offer'))}
      </span>
      <span className="notification-prompt-actions">
        {status === 'can-enable' && (
          <button type="button" className="notification-prompt-enable" onClick={enable}>
            {t('settings.notificationPrompt.enable')}
          </button>
        )}
        <button type="button" className="reply-close" onClick={dismiss} aria-label={t('settings.dismiss')}>
          ×
        </button>
      </span>
    </div>
  );
}
