import React, { useCallback, useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHardDrive } from '@fortawesome/free-solid-svg-icons';
import { setPrivacyPref, usePrivacyPrefs } from '../utils/privacy';
import { clearOfflineCopy, offlineCopySize } from '../services/offlineCopy';
import { clearSearchIndex, searchIndexSize } from '../services/searchIndex';
import { formatBytes } from '../utils/formatBytes';
import { isDesktopApp } from '../utils/desktop';
import { isAndroidApp } from '../utils/android';
import { t } from '../i18n';

// What the browser says this site stores in all: { usage, quota } (bytes), or null.
async function estimate() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

// Whether the browser keeps this site's storage when space runs low: true / false, or null
// where it doesn't say (and the desktop and Android apps, whose storage is their own).
async function persisted() {
  if (isDesktopApp() || isAndroidApp() || !navigator.storage?.persisted) return null;
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

// Settings → Privacy → Storage on this device: how much Voicaw keeps here, the offline copy
// (services/offlineCopy.js) and the search copy (services/searchIndex.js), each with its
// switch and Clear, and on the web whether the browser may delete it all when space runs low.
export default function StorageSettings() {
  const prefs = usePrivacyPrefs();
  const [sizes, setSizes] = useState(null);
  const [busy, setBusy] = useState(false);

  const measure = useCallback(async () => {
    const [offline, search, total, kept] = await Promise.all([
      offlineCopySize().catch(() => null),
      searchIndexSize().catch(() => null),
      estimate(),
      persisted(),
    ]);
    setSizes({ offline, search, total, kept });
  }, []);

  useEffect(() => { measure(); }, [measure]);

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      console.error('Storage settings', err);
    } finally {
      await measure();
      setBusy(false);
    }
  };

  const toggleOffline = (on) => run(async () => {
    setPrivacyPref('offlineCopy', on);
    if (!on) await clearOfflineCopy();
  });
  const toggleSearch = (on) => run(async () => {
    setPrivacyPref('searchCopy', on);
    if (!on) await clearSearchIndex();
  });
  const askToKeep = () => run(() => navigator.storage.persist());

  const offline = sizes?.offline;
  const search = sizes?.search;
  return (
    <div className="settings-card">
      <h5><FontAwesomeIcon icon={faHardDrive} className="settings-card-icon" />{t('settings.storage.title')}</h5>
      <p className="vc-hint">
        {sizes?.total
          ? t('settings.storage.total', { used: formatBytes(sizes.total.usage), free: formatBytes(Math.max(0, sizes.total.quota - sizes.total.usage)) })
          : t('settings.storage.totalUnknown')}
      </p>

      <label className="settings-toggle">
        <input type="checkbox" checked={prefs.offlineCopy} disabled={busy} onChange={(e) => toggleOffline(e.target.checked)} />
        {' '}{t('settings.storage.offlineCopy.label')}
      </label>
      <p className="vc-hint">{t('settings.storage.offlineCopy.hint')}</p>
      <div className="storage-row">
        <span>
          {offline
            ? t('settings.storage.offlineCopy.size', { size: formatBytes(offline.bytes), count: offline.messages, chats: offline.chats })
            : t('common.loading')}
        </span>
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy || !offline?.bytes} onClick={() => run(clearOfflineCopy)}>
          {t('settings.storage.clear')}
        </button>
      </div>

      <label className="settings-toggle">
        <input type="checkbox" checked={prefs.searchCopy} disabled={busy} onChange={(e) => toggleSearch(e.target.checked)} />
        {' '}{t('settings.privacy.searchCopy.label')}
      </label>
      <p className="vc-hint">{t('settings.privacy.searchCopy.hint')}</p>
      <div className="storage-row">
        <span>
          {search
            ? t('settings.storage.searchCopy.size', { size: formatBytes(search.bytes), count: search.chats })
            : t('common.loading')}
        </span>
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy || !search?.bytes} onClick={() => run(clearSearchIndex)}>
          {t('settings.storage.clear')}
        </button>
      </div>

      {sizes?.kept != null && (
        <>
          <p className="vc-hint mt-3">
            {sizes.kept ? t('settings.storage.persisted') : t('settings.storage.notPersisted')}
          </p>
          {!sizes.kept && (
            <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={askToKeep}>
              {t('settings.storage.persist')}
            </button>
          )}
        </>
      )}
      <p className="vc-hint mt-3">{t('settings.storage.logout')}</p>
    </div>
  );
}
