import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCloudArrowDown, faWifi } from '@fortawesome/free-solid-svg-icons';
import { useOfflineMode } from '../utils/offlineMode';
import { t } from '../i18n';

// Offline mode (utils/offlineMode.js): says the app is showing this device's offline copy,
// read-only; once the server answers again, Reconnect reloads the app online. Dismissing hides
// it until the server is back.
export default function OfflineBanner() {
  const { offline, reachable } = useOfflineMode();
  const [dismissed, setDismissed] = useState(null);

  if (!offline || dismissed === reachable) return null;

  return (
    <div className="update-banner offline-banner" role="status">
      <span className="update-banner-icon" aria-hidden="true">
        <FontAwesomeIcon icon={reachable ? faWifi : faCloudArrowDown} />
      </span>
      <span className="update-banner-text">
        <strong>{t(reachable ? 'app.offline.backTitle' : 'app.offline.title')}</strong>
        <span>{t(reachable ? 'app.offline.backText' : 'app.offline.text')}</span>
      </span>
      {reachable && (
        <button type="button" className="update-banner-button" onClick={() => window.location.reload()}>
          {t('app.offline.reconnect')}
        </button>
      )}
      <button type="button" className="update-banner-close" onClick={() => setDismissed(reachable)} aria-label={t('settings.dismiss')}>
        ×
      </button>
    </div>
  );
}
