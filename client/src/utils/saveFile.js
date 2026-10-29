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

// Saves an object (blob:) URL as a file called `name`.
export function triggerDownload(objectUrl, name) {
  if (isAndroidApp()) return saveInAndroidApp(objectUrl, name, false);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
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
