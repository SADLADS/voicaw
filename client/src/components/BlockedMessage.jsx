import React, { useState } from 'react';
import { t } from '../i18n';

// A message from someone you've blocked (utils/blocks.js), in a guild or group: collapsed until
// you choose to see it, as in Discord, so a conversation still makes sense around it.
export default function BlockedMessage({ children }) {
  const [shown, setShown] = useState(false);
  if (shown) {
    return (
      <div className="blocked-message shown">
        {children}
        <button type="button" className="link-button blocked-message-toggle" onClick={() => setShown(false)}>
          {t('chat.blocked.hide')}
        </button>
      </div>
    );
  }
  return (
    <div className="blocked-message">
      <span>{t('chat.blocked.message')}</span>
      <button type="button" className="link-button blocked-message-toggle" onClick={() => setShown(true)}>
        {t('chat.blocked.show')}
      </button>
    </div>
  );
}
