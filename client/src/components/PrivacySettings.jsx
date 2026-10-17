import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPuzzlePiece } from '@fortawesome/free-solid-svg-icons';
import { setPrivacyPref, usePrivacyPrefs } from '../utils/privacy';
import { getSetting, setSetting } from '../services/settingsStore';
import { t } from '../i18n';

// Settings → Privacy: choices that trade a little privacy for convenience, on this device
// (utils/privacy; notification previews in services/settingsStore, which the service worker
// reads). Each defaults to the convenient option; turning it off is the private one. The
// search and offline copies are the next subsection's (StorageSettings).
export default function PrivacySettings() {
  const prefs = usePrivacyPrefs();
  // null until IndexedDB answers (the switch waits, so a click can't be undone by the load).
  const [notificationPreviews, setNotificationPreviews] = useState(null);
  useEffect(() => {
    getSetting('notificationPreviews').then(setNotificationPreviews);
  }, []);
  const toggleNotificationPreviews = (e) => {
    setNotificationPreviews(e.target.checked);
    setSetting('notificationPreviews', e.target.checked).catch((err) => console.error('Could not save the setting', err));
  };
  return (
    <div className="settings-card">
      <h5><FontAwesomeIcon icon={faPuzzlePiece} className="settings-card-icon" />{t('settings.privacy.title')}</h5>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={notificationPreviews ?? true}
          disabled={notificationPreviews === null}
          onChange={toggleNotificationPreviews}
        />
        {' '}{t('settings.privacy.notificationPreviews.label')}
      </label>
      <p className="vc-hint">
        {t('settings.privacy.notificationPreviews.hint')}
      </p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.inviteEmbedsInEncrypted}
          onChange={(e) => setPrivacyPref('inviteEmbedsInEncrypted', e.target.checked)}
        />
        {' '}{t('settings.privacy.inviteEmbeds.label')}
      </label>
      <p className="vc-hint">
        {t('settings.privacy.inviteEmbeds.hint')}
      </p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.sendTyping}
          onChange={(e) => setPrivacyPref('sendTyping', e.target.checked)}
        />
        {' '}{t('settings.privacy.typing.label')}
      </label>
      <p className="vc-hint">
        {t('settings.privacy.typing.hint')}
      </p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.youtubeEmbeds}
          onChange={(e) => setPrivacyPref('youtubeEmbeds', e.target.checked)}
        />
        {' '}{t('settings.privacy.youtube.label')}
      </label>
      <p className="vc-hint">
        {t('settings.privacy.youtube.hint')}
      </p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.showLinkPreviews}
          onChange={(e) => setPrivacyPref('showLinkPreviews', e.target.checked)}
        />
        {' '}{t('settings.privacy.showLinkPreviews.label')}
      </label>
      <p className="vc-hint">
        {t('settings.privacy.showLinkPreviews.hint')}
      </p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.linkPreviews}
          disabled={!prefs.showLinkPreviews}
          onChange={(e) => setPrivacyPref('linkPreviews', e.target.checked)}
        />
        {' '}{t('settings.privacy.linkPreviews.label')}
      </label>
      <p className="vc-hint">
        {t('settings.privacy.linkPreviews.hint')}
      </p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.gifs}
          onChange={(e) => setPrivacyPref('gifs', e.target.checked)}
        />
        {' '}{t('settings.privacy.gifs.label')}
      </label>
      <p className="vc-hint">
        {t('settings.privacy.gifs.hint')}
      </p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.safetyNumbers}
          onChange={(e) => setPrivacyPref('safetyNumbers', e.target.checked)}
        />
        {' '}{t('settings.privacy.safetyNumbers.label')}
      </label>
      <p className="vc-hint">
        {t('settings.privacy.safetyNumbers.hint')}
      </p>
    </div>
  );
}
