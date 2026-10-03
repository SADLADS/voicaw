import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../i18n';

const DISMISSED_KEY = 'recoveryPromptDismissed';

// A one-line banner for accounts made before recovery codes, until they set one up.
// Dismissing it hides it on this device.
export default function RecoveryPrompt({ user }) {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === String(user?.id));

  if (!user || user.hasRecoveryCode !== false || dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, String(user.id));
    setDismissed(true);
  };

  return (
    <div className="notification-prompt" role="region" aria-label={t('settings.recoveryCode.title')}>
      <span>{t('settings.recoveryPrompt.text')}</span>
      <span className="notification-prompt-actions">
        <button type="button" className="notification-prompt-enable" onClick={() => navigate('/settings#account-security')}>
          {t('settings.recoveryPrompt.setUp')}
        </button>
        <button type="button" className="reply-close" onClick={dismiss} aria-label={t('settings.dismiss')}>
          ×
        </button>
      </span>
    </div>
  );
}
