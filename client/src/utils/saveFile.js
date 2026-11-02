import { isAndroidApp, saveToDownloads, showAndroidToast } from './android';
import { t } from '../i18n';

// The Android app's WebView can't save files itself: they go into Downloads (and with `open`
// are opened from there), with a notification that opens the file when tapped (a toast if
// notifications are off, or if it couldn't be opened).
async function saveInAndroidApp(objectUrl, name, open) {
  try {
    const blob = await (await fetch(objectUrl)).blob();
    const notify = open ? null : { title: name, body: t('media.save.notificationBody') };
    const { opened, notified } = await saveToDownloads(blob, name, { open, notify });
    if (!opened && !notified) showAndroidToast(t('media.save.saved', { name }));
  } catch (err) {
    console.warn('Could not save the file', err);
    showAndroidToast(t('media.save.failed'));
  }
}

// iPhones and iPads (iPadOS Safari says it's a Mac; a Mac has no touch screen).
const isIOS = () => typeof navigator !== 'undefined'
  && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

// iOS saves a download into Files, and a web page can't reach the photo library: only the share
// sheet can, so pictures and videos go there (its Save Image / Save Video). Resolves to whether
// the sheet opened; it can't on an older iOS, or once the tap that asked is too long ago (a big
// file decrypting), and then it's an ordinary download after all.
async function shareToPhotos(objectUrl, name) {
  if (!isIOS() || !navigator.canShare) return false;
  const blob = await (await fetch(objectUrl)).blob();
  if (!/^(image|video)\//.test(blob.type)) return false;
  const file = new File([blob], name, { type: blob.type });
  if (!navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err?.name !== 'AbortError') return false; // AbortError: closed without saving
  }
  return true;
}

function downloadLink(objectUrl, name) {
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Saves an object (blob:) URL as a file called `name`.
export async function triggerDownload(objectUrl, name) {
  if (isAndroidApp()) return saveInAndroidApp(objectUrl, name, false);
  if (await shareToPhotos(objectUrl, name).catch(() => false)) return;
  downloadLink(objectUrl, name);
}

// `name`: what a blob: URL is saved as in the Android app, which has no tabs, and where no other
// app can read one: it's saved to Downloads, then opened from there.
export function openInNewTab(url, name) {
  if (isAndroidApp() && url.startsWith('blob:')) return saveInAndroidApp(url, name || t('media.save.defaultName'), true);
  // Decrypted attachments are blob: URLs, which only resolve in a page from the same origin
  // and browsing-context group, so those can't be opened with noopener.
  if (url.startsWith('blob:')) window.open(url, '_blank');
  else window.open(url, '_blank', 'noopener,noreferrer');
}

// Attachments are already blob: URLs. Other images (legacy uploads, external links) are
// fetched first, since browsers ignore `download` on cross-origin links; when the server
// doesn't allow that (CORS), they're opened in a new tab to save from there instead.
export async function saveUrlAs(url, name) {
  if (url.startsWith('blob:')) {
    await triggerDownload(url, name);
    return;
  }
  try {
    // Without a referrer, like other sites' pictures are shown.
    const res = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const objectUrl = URL.createObjectURL(await res.blob());
    await triggerDownload(objectUrl, name);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch {
    openInNewTab(url);
  }
}
