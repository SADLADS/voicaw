import React, { useContext } from 'react';
import { Icon } from './Icon';
import { ImageViewerContext } from '../contexts';
import { faEye, faEyeSlash, faFile, faXmark } from '@fortawesome/free-solid-svg-icons';
import { formatBytes } from '../utils/formatBytes';
import { t } from '../i18n';

// Thumbnails of the attachments referenced in the message being composed. Images and videos
// can be marked as spoilers (sent blurred until clicked); the thumbnail is blurred to match.
// Clicking an image's thumbnail opens it in the image viewer, with the tray's other images.
export default function AttachmentTray({ drafts, onRemove, onToggleSpoiler }) {
  const viewer = useContext(ImageViewerContext);
  if (drafts.length === 0) return null;

  const images = drafts.filter((d) => d.type.startsWith('image/'));
  const openImage = (draft) => viewer.openImage({
    images: images.map((d) => ({ src: d.previewUrl, name: d.name, size: d.size, width: d.width, height: d.height })),
    index: images.indexOf(draft),
  });

  return (
    <div className="attachment-tray">
      {drafts.map((draft) => (
        <div className={`attachment-draft${draft.spoiler ? ' spoiler' : ''}`} key={draft.id} title={draft.name}>
          {draft.type.startsWith('image/') ? (
            viewer ? (
              <button
                type="button"
                className="attachment-draft-open"
                onClick={() => openImage(draft)}
                aria-label={t('media.tray.view', { name: draft.name })}
              >
                <img src={draft.previewUrl} alt={draft.name} />
              </button>
            ) : (
              <img src={draft.previewUrl} alt={draft.name} />
            )
          ) : draft.type.startsWith('video/') ? (
            <video src={draft.previewUrl} muted preload="metadata" />
          ) : (
            <div className="attachment-draft-file">
              <Icon icon={faFile} />
              <span className="attachment-draft-name">{draft.name}</span>
              <span className="attachment-draft-size">{formatBytes(draft.size)}</span>
            </div>
          )}
          {draft.spoiler && <span className="attachment-draft-spoiler-label">{t('media.tray.spoiler')}</span>}
          {onToggleSpoiler && (draft.type.startsWith('image/') || draft.type.startsWith('video/')) && (
            <button
              type="button"
              className={`attachment-draft-spoiler${draft.spoiler ? ' active' : ''}`}
              onClick={() => onToggleSpoiler(draft.id)}
              title={draft.spoiler ? t('media.tray.removeSpoiler') : t('media.tray.markSpoiler')}
              aria-label={draft.spoiler
                ? t('media.tray.removeSpoilerFrom', { name: draft.name })
                : t('media.tray.markNameSpoiler', { name: draft.name })}
              aria-pressed={!!draft.spoiler}
            >
              <Icon icon={draft.spoiler ? faEyeSlash : faEye} />
            </button>
          )}
          <button
            type="button"
            className="attachment-draft-remove"
            onClick={() => onRemove(draft.id)}
            title={t('media.tray.remove', { name: draft.name })}
            aria-label={t('media.tray.remove', { name: draft.name })}
          >
            <Icon icon={faXmark} />
          </button>
        </div>
      ))}
    </div>
  );
}
