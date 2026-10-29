import React from 'react';
import { Icon } from './Icon';
import { faCircleCheck, faFile, faFolderOpen, faTrash, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useDesktopDownloads } from '../hooks/useDesktopDownloads';
import { t } from '../i18n';

// The desktop app's "Download complete" popup in the top corner, as a browser shows one: each
// file just saved with Open file, Show in folder and Delete. It goes by itself a few seconds
// after the last one (not while the pointer is on it). Nothing in a browser or the Android app
// (which posts a notification instead, utils/android.js saveToDownloads).
export default function DownloadsPopup() {
  const { items, hold, open, showInFolder, remove, dismiss } = useDesktopDownloads();
  if (!items.length) return null;

  return (
    <div
      className="downloads-popup"
      role="status"
      aria-label={t('media.save.list')}
      onPointerEnter={() => hold(true)}
      onPointerLeave={() => hold(false)}
      onFocus={() => hold(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) hold(false); }}
    >
      <div className="downloads-popup-header">
        <Icon icon={faCircleCheck} className="downloads-popup-check" />
        <strong>{t('media.save.done')}</strong>
        <button type="button" className="downloads-popup-close" onClick={dismiss} aria-label={t('common.close')}>
          <Icon icon={faXmark} />
        </button>
      </div>
      {items.map((item) => (
        <div key={item.id} className="downloads-popup-item">
          <div className="downloads-popup-file">
            <span className="downloads-popup-file-icon" aria-hidden="true"><Icon icon={faFile} /></span>
            <span className="downloads-popup-file-text">
              <span className="downloads-popup-name" title={item.name}>{item.name}</span>
              <span className={item.error ? 'downloads-popup-error' : 'downloads-popup-where'}>
                {item.error ? t(`media.save.${item.error}`) : t('media.save.savedIn', { folder: item.folder })}
              </span>
            </span>
          </div>
          <div className="downloads-popup-actions">
            <button type="button" className="downloads-popup-open" onClick={() => open(item.id)}>
              {t('media.save.open')}
            </button>
            <button type="button" className="downloads-popup-button" onClick={() => showInFolder(item.id)}>
              <Icon icon={faFolderOpen} /> {t('media.save.showInFolder')}
            </button>
            <button type="button" className="downloads-popup-button downloads-popup-delete" onClick={() => remove(item.id)}>
              <Icon icon={faTrash} /> {t('media.save.delete')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
