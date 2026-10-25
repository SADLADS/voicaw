import React from 'react';
import { setMessageDisplay, useMessageDisplay } from '../utils/messageDisplay';
import { t } from '../i18n';

const CHOICES = [
  ['cozy', 'settings.messageDisplay.cozy', 'settings.messageDisplay.cozyHint'],
  ['compact', 'settings.messageDisplay.compact', 'settings.messageDisplay.compactHint'],
];

// Settings → Appearance: cozy or compact messages, on this device only (utils/messageDisplay).
export default function MessageDisplaySettings() {
  const display = useMessageDisplay();
  return (
    <div className="settings-card">
      <h5>{t('settings.messageDisplay.title')}</h5>
      <div role="radiogroup" aria-label={t('settings.messageDisplay.title')}>
        {CHOICES.map(([value, label, hint]) => (
          <label key={value} className="settings-toggle message-display-choice">
            <input
              type="radio" name="message-display" value={value}
              checked={display === value}
              onChange={() => setMessageDisplay(value)}
            />
            {' '}<span>{t(label)}<span className="vc-hint">{t(hint)}</span></span>
          </label>
        ))}
      </div>
      <p className="vc-hint">{t('settings.theme.hint')}</p>
    </div>
  );
}
