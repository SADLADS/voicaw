import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import {
  SPELLCHECK_LANGUAGES, setSpellcheckEnabled, setSpellcheckLanguage, useSpellcheckSettings,
} from '../utils/spellcheck';
import { removeWord, useDictionaryWords } from '../spellcheck/personalDictionary';
import { t } from '../i18n';

// Settings → Spellcheck (not on a phone, whose keyboard checks spelling itself): underline
// misspelled words while typing, in which language (both on this device, utils/spellcheck),
// and the words you've added to your dictionary (your account's, encrypted:
// spellcheck/personalDictionary).
export default function SpellcheckSettings() {
  const { enabled, choice, language } = useSpellcheckSettings();
  const words = useDictionaryWords();
  return (
    <div className="settings-card">
      <h5>{t('settings.spellcheck.title')}</h5>
      <label className="settings-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setSpellcheckEnabled(e.target.checked)} />
        {' '}{t('settings.spellcheck.enabled')}
      </label>
      <div className="date-time-settings mt-2">
        <label htmlFor="spellcheck-language">{t('settings.spellcheck.language')}</label>
        <select id="spellcheck-language" value={choice} disabled={!enabled} onChange={(e) => setSpellcheckLanguage(e.target.value)}>
          <option value="auto">{t('settings.spellcheck.automatic')}</option>
          {SPELLCHECK_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{t(l.labelKey)}</option>)}
        </select>
      </div>
      <p className="vc-hint">
        {enabled && !language ? t('settings.spellcheck.hintNoLanguage') : t('settings.spellcheck.hint')}
      </p>
      <h6 className="mt-3">{t('settings.spellcheck.dictionary')}</h6>
      {words.length ? (
        <ul className="spellcheck-words">
          {words.map((word) => (
            <li key={word}>
              <span>{word}</span>
              <button type="button" className="btn btn-sm btn-link" aria-label={t('settings.spellcheck.removeWord', { word })} title={t('common.remove')} onClick={() => removeWord(word)}>
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vc-hint">{t('settings.spellcheck.noWords')}</p>
      )}
      <p className="vc-hint">{t('settings.spellcheck.wordsSynced')}</p>
    </div>
  );
}
