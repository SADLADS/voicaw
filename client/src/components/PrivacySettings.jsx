import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPuzzlePiece } from '@fortawesome/free-solid-svg-icons';
import { setPrivacyPref, usePrivacyPrefs } from '../utils/privacy';
import { t } from '../i18n';

// Settings → Privacy: choices that trade a little privacy for convenience, on this device
// (utils/privacy). Each defaults to the convenient option; turning it off is the private one.
export default function PrivacySettings() {
  const prefs = usePrivacyPrefs();
  return (
    <div className="settings-card">
      <h5><FontAwesomeIcon icon={faPuzzlePiece} className="settings-card-icon" />{t('settings.privacy.title')}</h5>
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
          checked={prefs.linkPreviews}
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
    </div>
  );
}
