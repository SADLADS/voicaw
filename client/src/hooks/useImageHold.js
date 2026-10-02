import { useCallback, useContext, useRef, useState } from 'react';
import { InteractionContext } from '../contexts';
import { imageAt } from '../utils/imageActions';
import { galleryItemOf } from '../utils/imageGallery';
import { useLongPress } from './useLongPress';

// On a phone, holding a picture inside an element (a document, its cover, the document
// editor) opens its menu (ImageMenu, as a sheet), as right-clicking does on a computer
// (PageMenus). Not in messages, where holding opens the message's actions. Returns
// { holdProps } to spread on the element, and `held` (the gallery item, or null) with
// `closeHeld`.
export function useImageHold() {
  const { isMobile } = useContext(InteractionContext);
  const [held, setHeld] = useState(null);
  const target = useRef(null);
  const press = useLongPress(() => {
    const item = imageAt(target.current, galleryItemOf);
    if (item) setHeld(item);
  }, { enabled: isMobile });
  const closeHeld = useCallback(() => setHeld(null), []);

  if (!isMobile) return { holdProps: {}, held: null, closeHeld };
  const onImage = (e) => Boolean(imageAt(e.target, galleryItemOf));
  const holdProps = {
    ...press,
    // Only a touch on a picture counts; elsewhere the page scrolls and selects as usual.
    onTouchStart(e) {
      target.current = e.target;
      if (onImage(e)) press.onTouchStart(e);
    },
    onContextMenu(e) {
      if (onImage(e)) e.preventDefault();
    },
  };
  return { holdProps, held, closeHeld };
}
