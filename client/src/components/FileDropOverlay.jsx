import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { faUpload } from '@fortawesome/free-solid-svg-icons';
import { t } from '../i18n';

// Over the whole window while files are dragged in (see useWindowFileDrop): dropping them
// anywhere attaches them to the message being written. `title` says where ("Upload to Alice").
export default function FileDropOverlay({ title }) {
  return createPortal(
    <div className="file-drop-overlay" role="status">
      <div className="file-drop-card">
        <div className="file-drop-inner">
          <Icon icon={faUpload} className="file-drop-icon" />
          <div className="file-drop-title">{title}</div>
          <div className="file-drop-hint">{t('media.fileDrop.hint')}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
