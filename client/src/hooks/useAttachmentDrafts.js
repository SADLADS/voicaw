import { useContext, useEffect, useRef, useState } from 'react';
import { uploadAttachment, maxAttachmentBytes, DEFAULT_MAX_UPLOAD_BYTES } from '../services/attachmentUpload';
import { buildAttachmentUrl } from '../services/attachmentCrypto';
import { encryptedSize } from '../services/chunkedAttachment';
import { ConfigContext } from '../contexts';
import { formatBytes } from '../utils/formatBytes';
import { readMediaDimensions } from '../utils/mediaDimensions';
import { t } from '../i18n';
import { draftGeneration, keepAttachments, newDraftId, takeAttachments } from '../services/draftStore';

// Files attached to the message being composed. They stay on the device, referenced from the
// text as `![name](attachment:ID)` placeholders, until the message is sent (see
// utils/attachmentMarkup and services/attachmentUpload).
//
// - `insertAttachments(drafts)` puts new drafts into the message at the cursor (the editor
//   shows them as chips; in the text they're placeholders).
// - `onError(message | null)` reports (or clears) a problem, e.g. a file that's too big.
//
// Attachments belong to the conversation (`chatId`) they were added in: leaving it (another
// chat, or the composer going away) keeps them in draftStore with its text, and opening it
// again brings them back (`keptIds()` says which, for the text's placeholders).
export function useAttachmentDrafts({ chatId, s3Endpoint, insertAttachments, onError }) {
  const [drafts, setDrafts] = useState([]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const mediaInfo = useRef(new Map()); // draft id -> Promise of readMediaDimensions
  const [progress, setProgress] = useState(0);
  // Settings → Admin's File size limit, less room for the encryption.
  const limit = useContext(ConfigContext)?.maxUploadBytes || DEFAULT_MAX_UPLOAD_BYTES;
  const maxBytes = maxAttachmentBytes(limit);

  useEffect(() => {
    const since = draftGeneration();
    const kept = takeAttachments(chatId);
    draftsRef.current = kept?.drafts ?? [];
    mediaInfo.current = new Map(kept?.mediaInfo ?? []);
    setDrafts(draftsRef.current);
    return () => {
      const leaving = draftsRef.current;
      keepAttachments(chatId, {
        drafts: leaving,
        mediaInfo: [...mediaInfo.current].filter(([id]) => leaving.some((d) => d.id === id)),
      }, since);
      draftsRef.current = [];
      mediaInfo.current = new Map();
      setDrafts([]);
    };
  }, [chatId]);

  // The ids of the drafts now attached (right after `chatId` changed, those brought back).
  const keptIds = () => new Set(draftsRef.current.map((d) => d.id));

  // `source`: what the files were picked from (the + panel's gallery item), kept on their drafts
  // so the panel can show them as picked. Returns the new drafts.
  function addFiles(files, { source } = {}) {
    if (files.length === 0) return [];

    const tooBig = files.filter((f) => f.size > maxBytes);
    const accepted = files.filter((f) => f.size <= maxBytes);
    onError(
      tooBig.length > 0
        ? t('media.drafts.tooBig', {
          count: tooBig.length,
          names: tooBig.map((f) => f.name).join(', '),
          limit: formatBytes(limit),
        })
        : null
    );
    if (accepted.length === 0) return [];

    const newDrafts = accepted.map((file) => ({
      id: newDraftId(),
      file,
      name: file.name || t('media.drafts.defaultName'),
      type: file.type || 'application/octet-stream',
      size: file.size,
      previewUrl: URL.createObjectURL(file),
      ...(source != null ? { source } : {}),
    }));
    setDrafts((prev) => [...prev, ...newDrafts]);

    // Record image/video sizes (sent in the attachment URL) so receivers can reserve the
    // right space before the file loads; for videos also the duration and a poster, for big
    // images a thumbnail.
    newDrafts.forEach((d) => {
      const reading = readMediaDimensions(d.file, d.previewUrl);
      mediaInfo.current.set(d.id, reading);
      reading.then((dims) => {
        if (dims) setDrafts((prev) => prev.map((x) => (x.id === d.id ? { ...x, ...dims } : x)));
      });
    });

    insertAttachments(newDrafts);
    return newDrafts;
  }

  // A recorded voice message (services/voiceMessage.js) as a draft of its own: never in the
  // box nor the tray, as it's sent straight away as its own message. `previewUrl` is the
  // recording's URL (the recorder made it); `duration` and `waveform` go in its URL.
  function voiceDraft(file, { duration, waveform, previewUrl }) {
    return {
      id: newDraftId(),
      file,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      previewUrl,
      duration,
      waveform,
    };
  }

  // Marks an image or video as a spoiler (or not): it's sent blurred until clicked.
  function toggleSpoiler(id) {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, spoiler: !d.spoiler } : d)));
  }

  function removeDraft(id) {
    const draft = draftsRef.current.find((d) => d.id === id);
    if (draft) URL.revokeObjectURL(draft.previewUrl);
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }

  // On send: the drafts the text still references (`ids`) go with the message; the rest
  // (their placeholders were deleted) are dropped.
  function takeDrafts(ids) {
    const taken = draftsRef.current.filter((d) => ids.has(d.id));
    draftsRef.current.filter((d) => !ids.has(d.id)).forEach((d) => URL.revokeObjectURL(d.previewUrl));
    setDrafts([]);
    return taken;
  }

  // The final attachment URL has a fixed shape (see attachmentCrypto/attachmentUpload), so
  // a same-length stand-in lets us check the message length before uploading anything.
  function projectedUrl(draft) {
    return buildAttachmentUrl(`${s3Endpoint}/uploads/${'0'.repeat(36)}.bin`, {
      key: 'A'.repeat(43),
      type: draft.type,
      size: draft.size,
      width: draft.width,
      height: draft.height,
      spoiler: draft.spoiler,
      nonce: 'A'.repeat(16),
      duration: draft.duration,
      poster: draft.poster || draft.thumbnail ? `${'0'.repeat(36)}.bin` : null,
      waveform: draft.waveform,
    });
  }

  // Encrypts and uploads `attachments`, reporting overall progress; resolves to
  // { [draftId]: url }.
  async function upload(attachments) {
    const total = attachments.reduce((sum, d) => sum + encryptedSize(d.size), 0);
    const loaded = {};
    const report = () => {
      const done = Object.values(loaded).reduce((a, b) => a + b, 0);
      setProgress(Math.max(1, Math.round((done / total) * 100)));
    };

    report();
    try {
      const entries = await Promise.all(
        attachments.map(async (d) => {
          // Sent before its size and poster or thumbnail were read (a video on a slow
          // phone): wait for them, so others still get them. They're limited by timeouts.
          const read = (await mediaInfo.current.get(d.id)) ?? {};
          mediaInfo.current.delete(d.id);
          const width = d.width ?? read.width;
          const height = d.height ?? read.height;
          const info = width && height
            ? {
              width,
              height,
              duration: d.duration ?? read.duration,
              poster: d.poster ?? read.poster,
              thumbnail: d.thumbnail ?? read.thumbnail,
            }
            : d.waveform ? { duration: d.duration, waveform: d.waveform } : null;
          const url = await uploadAttachment(d.file, (bytes) => {
            loaded[d.id] = bytes;
            report();
          }, info, !!d.spoiler);
          return [d.id, url];
        })
      );
      return Object.fromEntries(entries);
    } finally {
      setProgress(0);
    }
  }

  // The device's file chooser; `accept` limits it (image/*,video/* is a phone's photo picker),
  // `capture` takes a new photo with the camera instead.
  function pickFiles({ accept, capture } = {}) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !capture;
    if (accept) input.accept = accept;
    // The attribute: Chrome has no `capture` property to set.
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';
    input.onchange = (e) => {
      addFiles(Array.from(e.target.files || []));
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  }

  return {
    drafts,
    progress,
    addFiles,
    pickFiles,
    removeDraft,
    toggleSpoiler,
    voiceDraft,
    takeDrafts,
    keptIds,
    projectedUrl,
    upload,
  };
}
