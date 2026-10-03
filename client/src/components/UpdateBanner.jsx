import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowsRotate } from '@fortawesome/free-solid-svg-icons';
import { applyUpdate, useAppUpdate } from '../utils/appUpdate';
import { t } from '../i18n';

// A small floating notice when a new version of Voicaw is ready. "Update" switches to it
// (reloading the page); dismissing hides it until the next update. Settings can also check.
export default function UpdateBanner() {
  const { available, seq } = useAppUpdate();
  const [dismissedSeq, setDismissedSeq] = useState(0);
  const [updating, setUpdating] = useState(false);

  if (!available || dismissedSeq === seq) return null;

  const update = () => {
    setUpdating(true);
    applyUpdate();
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-icon" aria-hidden="true">
        <FontAwesomeIcon icon={faArrowsRotate} spin={updating} />
      </span>
      <span className="update-banner-text">
        <strong>{t('settings.updateBanner.title')}</strong>
        <span>{updating ? t('settings.updateBanner.restarting') : t('settings.appVersion.ready')}</span>
      </span>
      <button type="button" className="update-banner-button" onClick={update} disabled={updating}>
        {updating ? t('settings.appVersion.updating') : t('settings.updateBanner.update')}
      </button>
      {!updating && (
        <button type="button" className="update-banner-close" onClick={() => setDismissedSeq(seq)} aria-label={t('settings.dismiss')}>
          ×
        </button>
      )}
    </div>
  );
}
