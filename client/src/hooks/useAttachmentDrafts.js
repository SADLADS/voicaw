import { useEffect, useRef, useState } from 'react';
import { uploadAttachment, MAX_ATTACHMENT_BYTES } from '../services/attachmentUpload';
import { buildAttachmentUrl, ENCRYPTION_OVERHEAD_BYTES } from '../services/attachmentCrypto';
import { formatBytes } from '../utils/formatBytes';
import { readMediaDimensions } from '../utils/mediaDimensions';

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
  const [progress, setProgress] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepth = useRef(0);
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
        ? `${tooBig.map((f) => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit.`
        : null
    );
    if (accepted.length === 0) return;

    const newDrafts = accepted.map((file) => ({
      id: nextDraftId.current++,
      file,
      name: file.name || 'file',
      type: file.type || 'application/octet-stream',
      size: file.size,
      previewUrl: URL.createObjectURL(file),
    }));
    setDrafts((prev) => [...prev, ...newDrafts]);

    // Record image/video sizes (sent in the attachment URL) so receivers can reserve the
    // right space before the file loads.
    newDrafts.forEach((d) => {
      readMediaDimensions(d.file, d.previewUrl).then((dims) => {
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
    return buildAttachmentUrl(`${s3Endpoint}/uploads/${'0'.repeat(36)}.bin`, {
      key: 'A'.repeat(43),
      type: draft.type,
      size: draft.size,
      width: draft.width,
      height: draft.height,
      spoiler: draft.spoiler,
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
          const dims = d.width && d.height ? { width: d.width, height: d.height } : null;
          const url = await uploadAttachment(d.file, (bytes) => {
            loaded[d.id] = bytes;
            report();
          }, dims, !!d.spoiler);
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

  // Only react to drags carrying files, so dragging text into the textarea still works.
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  const dropHandlers = {
    onDragEnter(e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setIsDragOver(true);
    },
    onDragLeave(e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setIsDragOver(false);
    },
    onDragOver(e) {
      if (isFileDrag(e)) e.preventDefault();
    },
    onDrop(e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setIsDragOver(false);
      addFiles(Array.from(e.dataTransfer.files || []));
    },
  };

  return {
    drafts,
    progress,
    isDragOver,
    dropHandlers,
    addFiles,
    pickFiles,
    removeDraft,
    toggleSpoiler,
    takeDrafts,
    projectedUrl,
    upload,
  };
}
