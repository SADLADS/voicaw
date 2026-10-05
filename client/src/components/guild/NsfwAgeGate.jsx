import React, { useState } from 'react';
import { setPreference } from '../../utils/preferences';
import { t } from '../../i18n';

// What an NSFW channel (or a thread in one) shows until you've ticked "I am 18 or over": the
// answer is kept with your account (the `adultConfirmed` preference, so you're asked once on
// every device), never a date of birth or an age. Settings → Content can change it later.
export default function NsfwAgeGate({ channelName, onBack }) {
  const [adult, setAdult] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function open() {
    setSaving(true);
    setError(null);
    try {
      await setPreference('adultConfirmed', true);
    } catch {
      setError(t('guilds.nsfwGate.error'));
      setSaving(false);
    }
  }

  return (
    <div className="nsfw-gate">
      <div className="nsfw-gate-card" role="group" aria-labelledby="nsfw-gate-title">
        <span className="channel-nsfw-tag">{t('guilds.view.nsfw')}</span>
        <h2 id="nsfw-gate-title">{t('guilds.nsfwGate.title', { name: channelName })}</h2>
        <p>{t('guilds.nsfwGate.text')}</p>
        <label className="nsfw-gate-confirm">
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} disabled={saving} />
          {' '}{t('guilds.nsfwGate.confirm')}
        </label>
        <p className="vc-hint">{t('guilds.nsfwGate.kept')}</p>
        {error && <p className="error-msg" role="alert">{error}</p>}
        <div className="nsfw-gate-actions">
          <button type="button" className="btn btn-secondary" onClick={onBack}>{t('guilds.nsfwGate.back')}</button>
          <button type="button" className="btn btn-primary" onClick={open} disabled={!adult || saving}>
            {t('guilds.nsfwGate.continue')}
          </button>
        </div>
      </div>
    </div>
  );
}
