import { android, readMedia } from '../utils/android';
import { showErrorToast } from './toasts';
import { t } from '../i18n';

// GIFs and stickers from the phone's keyboard (the Android app's `keyboardContent` event,
// KeyboardContent.java): { id, uri, name, type, size }. The app tells the keyboard that
// multi-line boxes take pictures; here the file is read from the keyboard (only now) and pasted
// into the box that has focus, as a pasted picture would be: the message box attaches it, a
// document puts it in. Anything else says it can't take one.

const EXTENSIONS = { 'image/gif': 'gif', 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };

// Keyboards' names often have no extension (or none at all); attachments go by it.
export function keyboardFileName(name, type) {
  const extension = EXTENSIONS[type] || (type?.startsWith('image/') ? type.slice(6).replace(/[^a-z0-9]/gi, '') : '');
  const base = (name || '').trim() || 'image';
  if (!extension || /\.[a-z0-9]{2,5}$/i.test(base)) return base;
  return `${base}.${extension}`;
}

// Pastes `file` into `target`: true if something took it.
export function pasteFile(target, file) {
  const clipboardData = new DataTransfer();
  clipboardData.items.add(file);
  const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
  return !target.dispatchEvent(event);
}

export async function receiveKeyboardContent(content, { plugin = android, read = readMedia, paste = pasteFile, doc = document } = {}) {
  // The box it was sent to; reading the file takes a moment.
  const target = doc.activeElement;
  const name = keyboardFileName(content.name, content.type);
  let file;
  try {
    file = await read({ uri: content.uri, name, type: content.type || '' });
  } catch (err) {
    showErrorToast(t('chat.keyboardImage.failed'), err);
    return false;
  } finally {
    plugin?.releaseKeyboardContent({ id: content.id }).catch(() => {});
  }
  const into = target?.isConnected && target !== doc.body ? target : doc.activeElement;
  if (into && into !== doc.body && paste(into, file)) return true;
  showErrorToast(t('chat.keyboardImage.failed'), t('chat.keyboardImage.notHere'));
  return false;
}
