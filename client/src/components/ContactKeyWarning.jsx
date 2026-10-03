import React, { useState } from 'react';
import { t } from '../i18n';

// Shown instead of a conversation whose keys can't be trusted (see contactKeys.js).
export default function ContactKeyWarning({ status, username, onAccept }) {
  const [busy, setBusy] = useState(false);
  const name = username || t('chat.contactKey.thisPerson');

  if (status === 'invalid') {
    return (
      <div className="contact-key-warning" role="alert">
        <strong>{t('chat.contactKey.invalidTitle', { name })}</strong>
        <p>{t('chat.contactKey.invalidBody', { name })}</p>
      </div>
    );
  }

  const accept = async () => {
    setBusy(true);
    try {
      await onAccept();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="contact-key-warning" role="alert">
      <strong>{t('chat.contactKey.changedTitle', { name })}</strong>
      <p>{t('chat.contactKey.changedBody', { name })}</p>
      <button type="button" className="btn btn-sm btn-warning" onClick={accept} disabled={busy}>
        {t('chat.contactKey.accept')}
      </button>
    </div>
  );
}
