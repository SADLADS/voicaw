import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFile, faXmark } from '@fortawesome/free-solid-svg-icons';
import { formatBytes } from '../utils/formatBytes';

// Thumbnails of the attachments referenced in the message being composed.
export default function AttachmentTray({ drafts, onRemove }) {
  if (drafts.length === 0) return null;

  return (
    <div className="attachment-tray">
      {drafts.map((draft) => (
        <div className="attachment-draft" key={draft.id} title={draft.name}>
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
