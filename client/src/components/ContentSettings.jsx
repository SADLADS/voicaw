import React, { useState } from 'react';
import { setPreference, usePreferences } from '../utils/preferences';

// Settings → Content: what's covered in messages. Saved to your account (utils/preferences), so
// it's the same on every device.
export default function ContentSettings() {
  const prefs = usePreferences();
  const [error, setError] = useState(null);
  const change = (key, value) => {
    setError(null);
    setPreference(key, value).catch((err) => setError(err.response?.data?.error || err.message || 'Saving failed'));
  };
  return (
    <div className="settings-card">
      <h5>Content</h5>
      <label className="settings-toggle">
        <input type="checkbox" checked={prefs.blurNsfw} onChange={(e) => change('blurNsfw', e.target.checked)} />
        {' '}Blur media in NSFW channels
      </label>
      <p className="vc-hint">
        Images, videos, GIFs and embeds in guild channels marked NSFW are blurred until you click
        them. Turn this off to see them straight away. Anything sent as a spoiler stays blurred
        either way. Saved to your account, for all your devices.
      </p>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}
