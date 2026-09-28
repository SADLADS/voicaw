import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFile, faDownload } from '@fortawesome/free-solid-svg-icons';
import { parseAttachmentUrl } from '../services/attachmentCrypto';
import { loadDecryptedAttachment } from '../services/attachmentCache';
import { formatBytes } from '../utils/formatBytes';
import { placeholderIdFromUrl } from '../utils/attachmentMarkup';

function kindOf(type) {
  if (type?.startsWith('image/')) return 'image';
  if (type?.startsWith('video/')) return 'video';
  return 'file';
}

function triggerDownload(objectUrl, name) {
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Spans rather than divs throughout: markdown renders images inside <p>.
function FileBox({ name, size, onDownload, status }) {
  return (
    <span className="attachment-file">
      <FontAwesomeIcon icon={faFile} className="attachment-file-icon" />
      <span className="attachment-file-info">
        <span className="attachment-file-name" title={name}>{name}</span>
        <span className="attachment-file-size">
          {status === 'loading' ? 'Decrypting…' : status === 'error' ? 'Download failed' : formatBytes(size)}
        </span>
      </span>
      <button
        type="button"
        className="attachment-file-download"
        onClick={onDownload}
        disabled={status === 'loading'}
        title={`Download ${name}`}
        aria-label={`Download ${name}`}
      >
        <FontAwesomeIcon icon={faDownload} />
      </button>
    </span>
  );
}

function MediaView({ kind, src, name, size, onDownload }) {
  const [failed, setFailed] = useState(false);

  // e.g. a video codec the browser can't play: still let the user download it.
  if (failed) return <FileBox name={name} size={size} onDownload={onDownload} />;

  if (kind === 'image') {
    return <img className="attachment-media" src={src} alt={name} onError={() => setFailed(true)} />;
  }
  return (
    <video className="attachment-media" src={src} controls preload="metadata" onError={() => setFailed(true)} />
  );
}

function LocalAttachment({ local, name }) {
  const kind = kindOf(local.type);
  const download = () => triggerDownload(local.previewUrl, name);
  if (kind === 'file') return <FileBox name={name} size={local.size} onDownload={download} />;
  return <MediaView kind={kind} src={local.previewUrl} name={name} size={local.size} onDownload={download} />;
}

function EncryptedAttachment({ url, meta, name }) {
  const kind = kindOf(meta.type);
  const [state, setState] = useState({ status: 'idle', objectUrl: null });

  const load = () => {
    setState((s) => (s.objectUrl ? s : { status: 'loading', objectUrl: null }));
    return loadDecryptedAttachment(url, meta).then(
      (objectUrl) => {
        setState({ status: 'ready', objectUrl });
        return objectUrl;
      },
      (err) => {
        console.error('Failed to load attachment', err);
        setState({ status: 'error', objectUrl: null });
        return null;
      }
    );
  };

  // Images and videos load as soon as they're rendered; other files only on request.
  useEffect(() => {
    if (kind !== 'file') load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const download = async () => {
    const objectUrl = state.objectUrl || (await load());
    if (objectUrl) triggerDownload(objectUrl, name);
  };

  if (kind === 'file') {
    return <FileBox name={name} size={meta.size} onDownload={download} status={state.status} />;
  }
  if (state.status === 'error') {
    return <FileBox name={name} size={meta.size} onDownload={download} status="error" />;
  }
  if (!state.objectUrl) {
    return <span className={`attachment-loading attachment-loading-${kind}`} aria-label={`Loading ${name}`} />;
  }
  return <MediaView kind={kind} src={state.objectUrl} name={name} size={meta.size} onDownload={download} />;
}

// Renders a markdown image (`![alt](src)`) from a message: a draft placeholder in a
// pending message, an encrypted attachment, or a plain image URL (legacy uploads and
// external images).
export default function Attachment({ src, alt, localAttachments }) {
  const name = alt || 'attachment';

  const placeholderId = placeholderIdFromUrl(src);
  if (placeholderId !== null) {
    const local = localAttachments?.[placeholderId];
    return local
      ? <LocalAttachment local={local} name={name} />
      : <span className="attachment-missing">📎 {name}</span>;
  }

  const meta = parseAttachmentUrl(src);
  if (!meta) return <img className="attachment-media" src={src} alt={alt} />;

  return <EncryptedAttachment url={src} meta={meta} name={name} />;
}
