import { useEffect, useRef, useState } from 'react';
import { uploadAttachment, MAX_ATTACHMENT_BYTES } from '../services/attachmentUpload';
import { buildAttachmentUrl, isStreamable, ENCRYPTION_OVERHEAD_BYTES } from '../services/attachmentCrypto';
import { formatBytes } from '../utils/formatBytes';
import { readMediaDimensions } from '../utils/mediaDimensions';
import { t } from '../i18n';

// Files attached to the message being composed. They stay on the device, referenced from the
// text as `![name](attachment:ID)` placeholders, until the message is sent (see
// utils/attachmentMarkup and services/attachmentUpload).
//
// - `insertAttachments(drafts)` puts new drafts into the message at the cursor (the editor
//   shows them as chips; in the text they're placeholders).
// - `onError(message | null)` reports (or clears) a problem, e.g. a file that's too big.
// - `onDiscard(drafts)` runs when the conversation (`chatId`) changes: unsent attachments
//   belong to the conversation they were added in, so their placeholders should go too.
export function useAttachmentDrafts({ chatId, s3Endpoint, insertAttachments, onError, onDiscard }) {
  const [drafts, setDrafts] = useState([]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const nextDraftId = useRef(1);
  const mediaInfo = useRef(new Map()); // draft id -> Promise of readMediaDimensions
  const [progress, setProgress] = useState(0);
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;

  useEffect(() => () => {
    const dropped = draftsRef.current;
    dropped.forEach((d) => URL.revokeObjectURL(d.previewUrl));
    setDrafts([]);
    onDiscardRef.current?.(dropped);
  }, [chatId]);

  function addFiles(files) {
    if (files.length === 0) return;

    const tooBig = files.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
    const accepted = files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
    onError(
      tooBig.length > 0
        ? t('media.drafts.tooBig', {
          count: tooBig.length,
          names: tooBig.map((f) => f.name).join(', '),
          limit: formatBytes(MAX_ATTACHMENT_BYTES),
        })
        : null
    );
    if (accepted.length === 0) return;

    const newDrafts = accepted.map((file) => ({
      id: nextDraftId.current++,
      file,
      name: file.name || t('media.drafts.defaultName'),
      type: file.type || 'application/octet-stream',
      size: file.size,
      previewUrl: URL.createObjectURL(file),
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
    const streamable = isStreamable(draft.type);
    return buildAttachmentUrl(`${s3Endpoint}/uploads/${'0'.repeat(36)}.bin`, {
      key: 'A'.repeat(43),
      type: draft.type,
      size: draft.size,
      width: draft.width,
      height: draft.height,
      spoiler: draft.spoiler,
      ...(streamable ? {
        nonce: 'A'.repeat(16),
        duration: draft.duration,
      } : {}),
      poster: draft.poster || draft.thumbnail ? `${'0'.repeat(36)}.bin` : null,
    });
  }

  // Encrypts and uploads `attachments`, reporting overall progress; resolves to
  // { [draftId]: url }.
  async function upload(attachments) {
    const total = attachments.reduce((sum, d) => sum + d.size + ENCRYPTION_OVERHEAD_BYTES, 0);
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
            : null;
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

  function pickFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
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
    takeDrafts,
    projectedUrl,
    upload,
  };
}
