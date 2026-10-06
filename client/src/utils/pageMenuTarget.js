import { editableAt } from './editActions';
import { imageAt } from './imageActions';
import { galleryItemOf } from './imageGallery';

// What a right-click on `element` gets from PageMenus, given the page's selected text:
// { kind: 'image', item } | { kind: 'text' } | { kind: 'page', link, selected, userId } | null.
// `userId` is the person shown there (an element marked `data-user-id`: a message's author, a
// mention, a member list row...), for Copy User ID. A message's own menu (MessageList) gives way
// to these.

// A link to another site (or an email address) at `element`, or null.
export function linkAt(element) {
  const link = element?.closest?.('a[href]');
  if (!link) return null;
  try {
    const url = new URL(link.href, window.location.href);
    if (url.protocol === 'mailto:') return url.href;
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== window.location.origin) return url.href;
  } catch {
    // Not a link worth offering.
  }
  return null;
}

export function pageMenuTarget(target, selectedText = '') {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  if (!element) return null;
  const item = imageAt(element, galleryItemOf);
  if (item) return { kind: 'image', item };
  if (editableAt(element)) return { kind: 'text' };
  const selected = selectedText.trim() ? selectedText : '';
  const link = linkAt(element);
  const userId = element.closest('[data-user-id]')?.dataset.userId ?? null;
  return link || selected || userId ? { kind: 'page', link, selected, userId } : null;
}
