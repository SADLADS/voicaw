import React from 'react';
import { LANGUAGES, languageChoice, setLanguage, t } from '../i18n';

// Settings → Language: the app's language on this device (i18n/index.js). Automatic follows the
// browser's; choosing one reloads the app in it.
export default function LanguageSettings() {
  return (
    <div className="settings-card">
      <h5>{t('settings.language.title')}</h5>
      <div className="date-time-settings">
        <label htmlFor="app-language">{t('settings.language.label')}</label>
        <select id="app-language" value={languageChoice() ?? ''} onChange={(e) => setLanguage(e.target.value || null)}>
          <option value="">{t('settings.language.automatic')}</option>
          {LANGUAGES.map((language) => (
            <option key={language.code} value={language.code} lang={language.code}>{language.name}</option>
          ))}
        </select>
      </div>
      <p className="vc-hint">{t('settings.language.hint')}</p>
    </div>
  );
}
