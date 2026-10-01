import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEye, faEyeSlash, faFile, faXmark } from '@fortawesome/free-solid-svg-icons';
import { formatBytes } from '../utils/formatBytes';

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
              <FontAwesomeIcon icon={faFile} />
              <span className="attachment-draft-name">{draft.name}</span>
              <span className="attachment-draft-size">{formatBytes(draft.size)}</span>
            </div>
          )}
          {draft.spoiler && <span className="attachment-draft-spoiler-label">Spoiler</span>}
          {onToggleSpoiler && (draft.type.startsWith('image/') || draft.type.startsWith('video/')) && (
            <button
              type="button"
              className={`attachment-draft-spoiler${draft.spoiler ? ' active' : ''}`}
              onClick={() => onToggleSpoiler(draft.id)}
              title={draft.spoiler ? 'Remove spoiler' : 'Mark as spoiler'}
              aria-label={draft.spoiler ? `Remove spoiler from ${draft.name}` : `Mark ${draft.name} as spoiler`}
              aria-pressed={!!draft.spoiler}
            >
              <FontAwesomeIcon icon={draft.spoiler ? faEyeSlash : faEye} />
            </button>
          )}
          <button
            type="button"
            className="attachment-draft-remove"
            onClick={() => onRemove(draft.id)}
            title={`Remove ${draft.name}`}
            aria-label={`Remove ${draft.name}`}
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      ))}
    </div>
  );
}
