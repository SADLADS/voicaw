import React, { useState } from 'react';
import { setPreference, usePreferences } from '../utils/preferences';
import { t } from '../i18n';

// Settings → Privacy → Your profile: which of your profile's tabs others see (UserProfile):
// your activity (the games you played; off also deletes their history and records no more),
// mutual friends, mutual guilds. Saved to your account (server/preferences.js).
const OPTIONS = ['showActivity', 'showMutualFriends', 'showMutualGuilds'];

export default function ProfileVisibilitySettings() {
  const prefs = usePreferences();
  const [error, setError] = useState(null);
  const change = (key, value) => {
    setError(null);
    setPreference(key, value).catch((err) => setError(err.response?.data?.error || err.message || t('settings.savingFailed')));
  };
  return (
    <div className="settings-card">
      <h5>{t('settings.profileVisibility.title')}</h5>
      <p className="vc-hint">{t('settings.profileVisibility.hint')}</p>
      {OPTIONS.map((key) => (
        <React.Fragment key={key}>
          <label className="settings-toggle">
            <input type="checkbox" checked={prefs[key]} onChange={(e) => change(key, e.target.checked)} />
            {' '}{t(`settings.profileVisibility.${key}`)}
          </label>
          <p className="vc-hint">{t(`settings.profileVisibility.${key}Hint`)}</p>
        </React.Fragment>
      ))}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}
