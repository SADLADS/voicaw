import React from 'react';
import { Icon } from './Icon';
import { faEye, faEyeSlash, faFile, faXmark } from '@fortawesome/free-solid-svg-icons';
import { formatBytes } from '../utils/formatBytes';
import { t } from '../i18n';

// Thumbnails of the attachments referenced in the message being composed. Images and videos
// can be marked as spoilers (sent blurred until clicked); the thumbnail is blurred to match.
export default function AttachmentTray({ drafts, onRemove, onToggleSpoiler }) {
  if (drafts.length === 0) return null;

  return (
    <div className="attachment-tray">
      {drafts.map((draft) => (
        <div className={`attachment-draft${draft.spoiler ? ' spoiler' : ''}`} key={draft.id} title={draft.name}>
          {draft.type.startsWith('image/') ? (
            <img src={draft.previewUrl} alt={draft.name} />
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
