import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import {
  SPELLCHECK_LANGUAGES, setSpellcheckEnabled, setSpellcheckLanguage, useSpellcheckSettings,
} from '../utils/spellcheck';
import { removeWord, useDictionaryWords } from '../spellcheck/personalDictionary';

// Settings → Spellcheck (not on a phone, whose keyboard checks spelling itself): underline
// misspelled words while typing, in which language (both on this device, utils/spellcheck),
// and the words you've added to your dictionary (your account's, encrypted:
// spellcheck/personalDictionary).
export default function SpellcheckSettings() {
  const { enabled, choice, language } = useSpellcheckSettings();
  const words = useDictionaryWords();
  return (
    <div className="settings-card">
      <h5>Spellcheck</h5>
      <label className="settings-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setSpellcheckEnabled(e.target.checked)} />
        {' '}Check spelling as you type
      </label>
      <div className="date-time-settings mt-2">
        <label htmlFor="spellcheck-language">Language</label>
        <select id="spellcheck-language" value={choice} disabled={!enabled} onChange={(e) => setSpellcheckLanguage(e.target.value)}>
          <option value="auto">Automatic</option>
          {SPELLCHECK_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </div>
      <p className="vc-hint">
        Misspelled words get a red underline. Right-click one for suggestions or to add it to your
        dictionary (Shift+right-click for the browser&apos;s own menu). Automatic picks from your
        browser&apos;s languages
        {enabled && !language && <> and found none of these, so your browser&apos;s (or the desktop app&apos;s) own spellcheck is used</>}.
        Saved on this device.
      </p>
      <h6 className="mt-3">Your dictionary</h6>
      {words.length ? (
        <ul className="spellcheck-words">
          {words.map((word) => (
            <li key={word}>
              <span>{word}</span>
              <button type="button" className="btn btn-sm btn-link" aria-label={`Remove ${word}`} title="Remove" onClick={() => removeWord(word)}>
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vc-hint">No words yet. &ldquo;Add to Dictionary&rdquo; on a misspelled word puts it here.</p>
      )}
      <p className="vc-hint">Your words follow your account to your other devices, end-to-end encrypted.</p>
    </div>
  );
}
