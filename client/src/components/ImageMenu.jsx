import React, { useCallback, useContext, useEffect, useState } from 'react';
import { InteractionContext } from '../contexts';
import { imageAt, imageMenuItems } from '../utils/imageActions';
import { galleryItemOf } from '../utils/imageGallery';
import ContextMenu from './ContextMenu';

// A picture's menu (utils/imageActions.js): Copy Image, Save Image, and Copy / Open Link (or
// Open Image for an encrypted attachment). `item` is a gallery item; `overViewer` when it's
// opened from the full-screen viewer.
export default function ImageMenu({ item, anchor, sheet, overViewer = false, onClose }) {
  return (
    <ContextMenu
      title={item.name || 'Image'}
      label={item.name || 'Image'}
      items={imageMenuItems(item)}
      anchor={anchor}
      sheet={sheet}
      overViewer={overViewer}
      onClose={onClose}
    />
  );
}

// Right-clicking a picture in a message (an attachment, a GIF, a webhook's embed or file
// image) opens its menu instead of the browser's. Mounted once (App), listening on the page.
// Not on a phone, where holding a message opens its actions (and holding a picture in the
// full-screen viewer, this menu).
export function MessageImageMenus() {
  const { isMobile } = useContext(InteractionContext);
  const [menu, setMenu] = useState(null); // { item, anchor }
  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (isMobile) return undefined;
    const onContextMenu = (e) => {
      const item = imageAt(e.target, galleryItemOf);
      if (!item) return;
      e.preventDefault();
      setMenu({ item, anchor: { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY } });
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, [isMobile]);

  if (!menu) return null;
  return <ImageMenu item={menu.item} anchor={menu.anchor} onClose={close} />;
}
