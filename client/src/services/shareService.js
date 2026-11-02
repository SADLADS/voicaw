import api from '../utils/api';
import { readMedia } from '../utils/android';
import { uploadAttachment } from './attachmentUpload';
import { encryptedSize } from './chunkedAttachment';
import { readMediaDimensions } from '../utils/mediaDimensions';
import { escapeAltText } from '../utils/attachmentMarkup';
import { t } from '../i18n';

// What another app shared to Voicaw (the Android app's `share` event, Share.java), waiting for
// the share screen (components/ShareDialog.jsx): { files: [{ uri, name, type, size }], text,
// skipped }. One at a time, a newer share replacing it. Only in memory: closing the app forgets
// it, and logging out clears it.
let pending = null;
const listeners = new Set();

export const getShare = () => pending;

export function setShare(share) {
  pending = share ?? null;
  for (const listener of listeners) listener();
}

export const clearShare = () => setShare(null);

export function onShareChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Where you last sent a message, newest first (server recentChats.js).
export async function fetchRecentChats() {
  return (await api.get('/recent-chats')).data;
}

// Reads the shared files from the phone (only now: they were shared as content:// addresses),
// encrypts and uploads each once, and returns their markup for a message, `![name](url)` each,
// as the message box would send them; the same links then go to every chat picked, as a
// forward's do. `onProgress(percent)`; `maxBytes` (attachmentUpload maxAttachmentBytes) is
// checked again once the file is read (Android may not have said its size).
export async function uploadSharedFiles(files, { maxBytes, onProgress } = {}) {
  const read = [];
  for (const shared of files) {
    let file;
    try {
      file = await readMedia(shared);
    } catch {
      throw new Error(t('chat.share.readFailed', { name: shared.name }));
    }
    if (file.size > maxBytes) throw Object.assign(new Error('too big'), { tooBig: [file.name] });
    read.push(file);
  }

  const total = read.reduce((sum, file) => sum + encryptedSize(file.size), 0) || 1;
  const loaded = read.map(() => 0);
  const report = () => onProgress?.(Math.max(1, Math.round((loaded.reduce((a, b) => a + b, 0) / total) * 100)));
  report();

  let markup = '';
  // One at a time: a phone holds one file's worth of work, not ten.
  for (const [i, file] of read.entries()) {
    const objectUrl = URL.createObjectURL(file);
    let info = null;
    try {
      const dims = await readMediaDimensions(file, objectUrl);
      if (dims?.width && dims?.height) {
        info = { width: dims.width, height: dims.height, duration: dims.duration, poster: dims.poster, thumbnail: dims.thumbnail };
      }
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    const url = await uploadAttachment(file, (bytes) => {
      loaded[i] = bytes;
      report();
    }, info);
    markup += `![${escapeAltText(file.name || t('media.drafts.defaultName'))}](${url})`;
  }
  return markup;
}

// The message sent: what was typed, then the files (on a line of their own).
export const shareText = (caption, markup) => [caption.trim(), markup].filter(Boolean).join('\n');
