import {
  getCachedAttachment, loadDecryptedAttachment, getCachedPoster, loadDecryptedPoster,
} from '../services/attachmentCache';
import { parseAttachmentUrl } from '../services/attachmentCrypto';
import { placeOf } from './imageLink';

// Which images the viewer can step through: the ones in the same message. Each viewable image
// (or its loading placeholder) registers its details on its element with `galleryItemRef`;
// the message's content element is marked `data-image-gallery`. Opening one collects every
// registered element inside that, in document (reading) order.
//
// An item is { src, name, size, width, height, meta }: `meta` (parseAttachmentUrl) means `src`
// is an encrypted attachment's URL, otherwise `src` can be shown as is. Collected, it also has
// `place` when it's in a chat's message (utils/imageLink.js placeOf, for the desktop app's Open
// Image).
const items = new WeakMap();

const located = (el) => {
  const place = placeOf(el);
  return place ? { ...items.get(el), place } : items.get(el);
};

export function galleryItemRef(item) {
  return (el) => {
    if (el) items.set(el, item);
  };
}

// The item registered on `el` (a `data-gallery-item` element), or undefined.
export function galleryItemOf(el) {
  return items.has(el) ? located(el) : undefined;
}

export function galleryAround(el) {
  const scope = el.closest('[data-image-gallery]');
  const elements = scope ? [...scope.querySelectorAll('[data-gallery-item]')] : [el];
  const found = elements.filter((e) => items.has(e));
  return {
    images: found.map(located),
    index: Math.max(0, found.indexOf(el)),
  };
}

// Whether to show an encrypted image's thumbnail (`p=`) rather than the file (`preview`, for
// small pictures such as the viewer's strip).
const usesThumbnail = (item, preview) => preview && Boolean(item.meta?.posterUrl);

// The URL to display, synchronously when there is one already. With `preview`, the image's
// thumbnail does too, and so does the file if it's already decrypted.
export function readyImageSrc(item, preview = false) {
  if (!item.meta) return item.src;
  const whole = getCachedAttachment(item.src);
  return whole || (usesThumbnail(item, preview) ? getCachedPoster(item.meta) : null);
}

// Resolves to the URL to display (decrypting it if needed); with `preview`, its thumbnail if
// it has one (or the file, if the thumbnail fails).
export function loadImageSrc(item, preview = false) {
  if (!item.meta) return Promise.resolve(item.src);
  const whole = () => loadDecryptedAttachment(item.src, item.meta);
  return usesThumbnail(item, preview) ? loadDecryptedPoster(item.meta).catch(whole) : whole();
}

// The gallery item for a picture known only by its URL (a document's cover, or an image in the
// document editor): an encrypted upload of ours, or another site's.
export function galleryItemFromUrl(url, name = 'image') {
  const meta = parseAttachmentUrl(url);
  return meta ? { src: url, name, size: meta.size, width: meta.width, height: meta.height, meta } : { src: url, name };
}
