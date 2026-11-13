import React from 'react';
import { setPipPref, usePipPrefs } from '../utils/pipPrefs';
import { t } from '../i18n';

// Settings → Appearance → Picture in picture, on this device only (utils/pipPrefs.js): whether
// a video from a message plays on in the corner when you leave it (on by default), and also
// when it's scrolled out of view (off by default).
export default function PipSettings() {
  const prefs = usePipPrefs();
  return (
    <div className="settings-card">
      <h5>{t('settings.pip.title')}</h5>
      <label className="settings-toggle">
        <input type="checkbox" checked={prefs.onLeave} onChange={(e) => setPipPref('onLeave', e.target.checked)} />
        {' '}{t('settings.pip.onLeave')}
      </label>
      <p className="vc-hint">{t('settings.pip.onLeaveHint')}</p>
      <label className={`settings-toggle${prefs.onLeave ? '' : ' disabled'}`}>
        <input
          type="checkbox"
          checked={prefs.onLeave && prefs.onScroll}
          disabled={!prefs.onLeave}
          onChange={(e) => setPipPref('onScroll', e.target.checked)}
        />
        {' '}{t('settings.pip.onScroll')}
      </label>
      <p className="vc-hint">{t('settings.pip.onScrollHint')}</p>
    </div>
  );
}
