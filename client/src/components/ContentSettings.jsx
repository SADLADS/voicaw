import React, { useState } from 'react';
import { setPreference, usePreferences } from '../utils/preferences';
import { t } from '../i18n';

// Settings → Content: what's covered in messages. Saved to your account (utils/preferences), so
// it's the same on every device.
export default function ContentSettings() {
  const prefs = usePreferences();
  const [error, setError] = useState(null);
  const change = (key, value) => {
    setError(null);
    setPreference(key, value).catch((err) => setError(err.response?.data?.error || err.message || t('settings.savingFailed')));
  };
  return (
    <div className="settings-card">
      <h5>{t('settings.content.title')}</h5>
      <label className="settings-toggle">
        <input type="checkbox" checked={prefs.blurNsfw} onChange={(e) => change('blurNsfw', e.target.checked)} />
        {' '}{t('settings.content.blurNsfw')}
      </label>
      <p className="vc-hint">
        {t('settings.content.blurNsfwHint')}
      </p>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}
