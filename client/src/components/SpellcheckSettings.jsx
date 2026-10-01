import React from 'react';
import { setSpellcheckEnabled, useSpellcheck } from '../utils/spellcheck';

// Settings → Spellcheck: underline misspelled words while typing, on this device (utils/spellcheck).
export default function SpellcheckSettings() {
  const enabled = useSpellcheck();
  return (
    <div className="settings-card">
      <h5>Spellcheck</h5>
      <label className="settings-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setSpellcheckEnabled(e.target.checked)} />
        {' '}Check spelling as you type
      </label>
      <p className="vc-hint">
        Misspelled words get a red underline. Right-click one for suggestions or to add it to your
        dictionary. Uses your browser&apos;s (or the desktop app&apos;s) languages and dictionary.
        Saved on this device.
      </p>
    </div>
  );
}
