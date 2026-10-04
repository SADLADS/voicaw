import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowsRotate } from '@fortawesome/free-solid-svg-icons';
import { androidUpdateText, applyUpdate, useAppUpdate } from '../utils/appUpdate';
import { formatBytes } from '../utils/formatBytes';
import { t } from '../i18n';

// A small floating notice when a new version of Voicaw is ready. "Update" switches to it
// (reloading the page, or in the Android app downloading it for Android to install);
// dismissing hides it until the next update. Settings can also check.
export default function UpdateBanner() {
  const update = useAppUpdate();
  const { available, seq, reloads } = update;
  const [dismissedSeq, setDismissedSeq] = useState(0);
  const [reloading, setReloading] = useState(false);

  if (!available || dismissedSeq === seq) return null;

  const updating = reloading || update.progress != null;
  const text = reloads
    ? (reloading ? t('settings.updateBanner.restarting') : t('settings.appVersion.ready'))
    : (androidUpdateText(update) ?? t('settings.updateBanner.androidReady', { version: update.version, size: formatBytes(update.size) }));

  const start = () => {
    if (reloads) setReloading(true);
    applyUpdate();
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-icon" aria-hidden="true">
        <FontAwesomeIcon icon={faArrowsRotate} spin={updating} />
      </span>
      <span className="update-banner-text">
        <strong>{t('settings.updateBanner.title')}</strong>
        <span>{text}</span>
      </span>
      <button type="button" className="update-banner-button" onClick={start} disabled={updating}>
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
