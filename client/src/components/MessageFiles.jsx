import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFile } from '@fortawesome/free-solid-svg-icons';
import VideoPlayer from './VideoPlayer';
import { saveUrlAs } from '../utils/saveFile';

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Files a webhook sent with a message (Discord's `attachments`; plain files in our object store,
// not encrypted, like the rest of a guild): images, videos and sounds inline, anything else a
// download box. Files whose URL is in `shownElsewhere` (an embed's image) are left out.
export default function MessageFiles({ attachments, shownElsewhere = [] }) {
  const files = (attachments ?? []).filter((file) => !shownElsewhere.includes(file.url));
  if (!files.length) return null;
  return (
    <div className="message-files">
      {files.map((file) => {
        const type = file.content_type ?? '';
        if (type.startsWith('image/')) {
          return (
            <a key={file.id} href={file.url} target="_blank" rel="noopener noreferrer" className="message-file-image">
              <img src={file.url} alt={file.description ?? file.filename} width={file.width} height={file.height} loading="lazy" />
            </a>
          );
        }
        if (type.startsWith('video/')) {
          return (
            <VideoPlayer
              key={file.id}
              src={file.url}
              name={file.filename}
              size={file.size}
              width={file.width}
              height={file.height}
              onDownload={() => saveUrlAs(file.url, file.filename)}
            />
          );
        }
        if (type.startsWith('audio/')) {
          return (
            <div key={file.id} className="message-file-box">
              <span className="message-file-name">{file.filename}</span>
              <audio src={file.url} controls preload="none" />
            </div>
          );
        }
        return (
          <a key={file.id} className="message-file-box" href={file.url} download={file.filename} target="_blank" rel="noopener noreferrer">
            <FontAwesomeIcon icon={faFile} className="message-file-icon" />
            <span className="message-file-name">{file.filename}</span>
            <span className="vc-hint">{fileSize(file.size)}</span>
          </a>
        );
      })}
    </div>
  );
}
