import { getCachedAttachment, loadDecryptedAttachment } from '../services/attachmentCache';

// Which images the viewer can step through: the ones in the same message. Each viewable image
// (or its loading placeholder) registers its details on its element with `galleryItemRef`;
// the message's content element is marked `data-image-gallery`. Opening one collects every
// registered element inside that, in document (reading) order.
//
// An item is { src, name, size, width, height, meta }: `meta` (parseAttachmentUrl) means `src`
// is an encrypted attachment's URL, otherwise `src` can be shown as is.
const items = new WeakMap();

export function galleryItemRef(item) {
  return (el) => {
    if (el) items.set(el, item);
  };
}

export function galleryAround(el) {
  const scope = el.closest('[data-image-gallery]');
  const elements = scope ? [...scope.querySelectorAll('[data-gallery-item]')] : [el];
  const found = elements.filter((e) => items.has(e));
  return {
    images: found.map((e) => items.get(e)),
    index: Math.max(0, found.indexOf(el)),
  };
}

// The URL to display, synchronously when there is one already.
export function readyImageSrc(item) {
  return item.meta ? getCachedAttachment(item.src) : item.src;
}

// Resolves to the URL to display (decrypting it if needed).
export function loadImageSrc(item) {
  return item.meta ? loadDecryptedAttachment(item.src, item.meta) : Promise.resolve(item.src);
}
