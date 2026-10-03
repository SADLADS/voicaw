import React from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faUpload } from '@fortawesome/free-solid-svg-icons';
import { t } from '../i18n';

// Over the whole window while files are dragged in (see useWindowFileDrop): dropping them
// anywhere attaches them to the message to `chatName`.
export default function FileDropOverlay({ chatName }) {
  return createPortal(
    <div className="file-drop-overlay" role="status">
      <div className="file-drop-card">
        <div className="file-drop-inner">
          <FontAwesomeIcon icon={faUpload} className="file-drop-icon" />
          <div className="file-drop-title">{t('media.fileDrop.title', { name: chatName })}</div>
          <div className="file-drop-hint">{t('media.fileDrop.hint')}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
