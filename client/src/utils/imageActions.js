import { faArrowUpRightFromSquare, faCopy, faDownload, faLink } from '@fortawesome/free-solid-svg-icons';
import { loadImageSrc, readyImageSrc } from './imageGallery';
import { openInNewTab, saveUrlAs } from './saveFile';
import { isDesktopApp } from './desktop';
import { browserImageLink } from './imageLink';
import { t } from '../i18n';

// What can be done with a picture (ImageMenu: right-click it in a message or in the full-screen
// viewer, or hold it in the viewer on a phone). `item` is a gallery item (utils/imageGallery.js:
// { src, name, meta? }). An encrypted attachment (`meta`) has no link worth sharing: its file is
// ciphertext and its key only lives inside the message, so it offers Open Image (the decrypted
// copy in a new tab) instead of Copy/Open Link. The desktop app has no tabs: there Open Image opens
// the web app in the browser at the picture (utils/imageLink.js), and isn't offered where the
// picture has no chat and message to link to.

// The picture's displayable URL: the decrypted copy already in memory when there is one.
const srcOf = async (item) => readyImageSrc(item) || loadImageSrc(item);

// The link to share, or null for an encrypted attachment or a file on this device (a `blob:`
// URL: an attachment being written or just sent).
export function imageLink(item) {
  return item.meta || item.src?.startsWith('blob:') ? null : item.src;
}

// A picture's bytes as PNG, the one image type every browser's clipboard takes (a GIF or WebP
// becomes its first frame, like copying an image in Discord).
async function pngBlob(src) {
  // Other sites' pictures are fetched like they're shown: without telling them where from.
  const res = await fetch(src, { referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(t('media.image.loadFailedStatus', { status: res.status }));
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error(t('media.image.copyFailed')))), 'image/png');
  });
}

// Copies the picture itself. The ClipboardItem gets a promise, so the clipboard write starts
// within the click (Safari needs that) while the picture is fetched or decrypted.
export async function copyImage(item) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error(t('media.image.browserCantCopy'));
  }
  const png = srcOf(item).then(pngBlob);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (err) {
    // A site that doesn't let other pages read its pictures (no CORS) can't be copied.
    throw new Error(err?.name === 'TypeError' || err?.name === 'NotAllowedError'
      ? t('media.image.cantBeCopied')
      : err?.message || t('media.image.copyFailed'));
  }
}

// What opening `item` in a new tab does (the menu's Open Link / Open Image, the viewer's button):
// its link, the decrypted copy, or in the desktop app the web app at the picture; null where the
// desktop app has nothing to open (no chat and message to link to, or a picture on this device).
export function imageOpener(item, userId = null) {
  const link = imageLink(item);
  if (link) return () => openInNewTab(link);
  if (isDesktopApp()) {
    const inBrowser = browserImageLink(item, userId);
    return inBrowser ? () => openInNewTab(inBrowser) : null;
  }
  return async () => openInNewTab(await srcOf(item), item.name || t('media.image.defaultFileName'));
}

// The menu's items for `item`; `userId` is the logged-in account (the desktop app's Open Image
// link says which it is).
export function imageMenuItems(item, userId = null) {
  const link = imageLink(item);
  const items = [
    {
      key: 'copy-image',
      label: t('media.image.copyImage'),
      icon: faCopy,
      onSelect: async () => {
        await copyImage(item);
      },
    },
    {
      key: 'save-image',
      label: t('media.image.saveImage'),
      icon: faDownload,
      onSelect: async () => saveUrlAs(await srcOf(item), item.name || t('media.image.defaultFileName')),
    },
  ];
  if (link) {
    items.push(
      { separator: true },
      {
        key: 'copy-link',
        label: t('media.image.copyLink'),
        icon: faLink,
        onSelect: async () => {
          await navigator.clipboard.writeText(link);
        },
      },
      { key: 'open-link', label: t('media.image.openLink'), icon: faArrowUpRightFromSquare, onSelect: () => openInNewTab(link) },
    );
  } else {
    const open = imageOpener(item, userId);
    if (open) {
      items.push(
        { separator: true },
        { key: 'open-image', label: t('media.image.openImage'), icon: faArrowUpRightFromSquare, onSelect: open },
      );
    }
  }
  return items;
}

// The picture a right-click at `target` is on, as a gallery item, or null: a message's image
// attachment or GIF (registered with the gallery), or a webhook's embed or file image. Not
// emoji, avatars or anything in the full-screen viewer (which has its own).
export function imageAt(target, galleryItemOf) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  if (!element || element.closest('.image-viewer')) return null;
  const registered = element.closest('[data-gallery-item]');
  if (registered && galleryItemOf(registered)) return galleryItemOf(registered);
  const img = element.closest('img');
  if (!img || img.matches('.emoji, .custom-emoji, .embed-author-icon, .embed-footer-icon')) return null;
  if (!img.closest('.message-embeds, .message-files, .dm-message-content')) return null;
  const src = img.currentSrc || img.src;
  if (!src || src.startsWith('data:')) return null;
  let name = img.getAttribute('alt') || '';
  if (!name) {
    try {
      name = decodeURIComponent(new URL(src).pathname.split('/').pop() || t('media.image.defaultFileName'));
    } catch {
      name = t('media.image.defaultFileName');
    }
  }
  return { src, name };
}
