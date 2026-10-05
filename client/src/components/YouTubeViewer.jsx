import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare, faXmark } from '@fortawesome/free-solid-svg-icons';
import { openInNewTab } from '../utils/saveFile';
import { t } from '../i18n';
import '../assets/css/imageViewer.css';

// A phone's YouTube player (UrlPreviews.jsx): full screen over the app, like the image viewer,
// so the chat itself never holds YouTube's frame (touches on it would never reach our page, and
// swipes starting on it couldn't move the panes). Playing starts at once. Tapping around the
// video, X, Escape or the back button closes it.
export default function YouTubeViewer({ id, link, onClose }) {
  const closeRef = useRef(null);

  // Keys go to the viewer only, before the composer's Escape-cancels-reply sees them.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  // Focus moves into the viewer (so typing doesn't go to the message box) and back after.
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  return createPortal(
    <div className="image-viewer youtube-viewer" role="dialog" aria-modal="true" aria-label={t('media.youtube.video')}>
      <div className="image-viewer-toolbar">
        <div className="image-viewer-title">
          <span className="image-viewer-name">{t('media.youtube.video')}</span>
        </div>
        <div className="image-viewer-actions">
          <button type="button" onClick={() => openInNewTab(link)} title={t('media.youtube.openOnYouTube')} aria-label={t('media.youtube.openOnYouTube')}>
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
          </button>
          <button type="button" ref={closeRef} onClick={onClose} title={t('media.viewer.closeTitle')} aria-label={t('common.close')}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      </div>
      <div className="youtube-viewer-stage" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <iframe
          className="youtube-viewer-frame"
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1`}
          title={t('media.youtube.video')}
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
        ></iframe>
      </div>
    </div>,
    document.body
  );
}
