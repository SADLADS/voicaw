import React, { useState } from 'react';
import { setPreference, usePreferences } from '../utils/preferences';
import { t } from '../i18n';

const CHOICES = [
  ['all', 'settings.reactionNotifications.all'],
  ['dms', 'settings.reactionNotifications.dms'],
  ['off', 'settings.reactionNotifications.off'],
];

// Settings → Notifications: whether you're told when someone reacts to your message
// (server/reactionPushes.js). Saved to your account, so it's the same on every device.
export default function ReactionNotificationSettings() {
  const { reactionNotifications } = usePreferences();
  const [error, setError] = useState(null);
  const change = (value) => {
    setError(null);
    setPreference('reactionNotifications', value).catch((err) => setError(err.response?.data?.error || err.message || t('settings.savingFailed')));
  };
  return (
    <div className="settings-card">
      <h5>{t('settings.reactionNotifications.title')}</h5>
      <div role="radiogroup" aria-label={t('settings.reactionNotifications.title')}>
        {CHOICES.map(([value, label]) => (
          <label key={value} className="settings-toggle">
            <input
              type="radio" name="reaction-notifications" value={value}
              checked={reactionNotifications === value}
              onChange={() => change(value)}
            />
            {' '}{t(label)}
          </label>
        ))}
      </div>
      <p className="vc-hint">{t('settings.reactionNotifications.hint')}</p>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}
