import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

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
    <div className="notification-prompt" role="region" aria-label="Recovery code">
      <span>Set up a recovery code, so you can reset your password if you forget it.</span>
      <span className="notification-prompt-actions">
        <button type="button" className="notification-prompt-enable" onClick={() => navigate('/settings#account-security')}>
          Set up
        </button>
        <button type="button" className="reply-close" onClick={dismiss} aria-label="Dismiss">
          ×
        </button>
      </span>
    </div>
  );
}
