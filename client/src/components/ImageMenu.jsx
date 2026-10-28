import React from 'react';
import { imageMenuItems } from '../utils/imageActions';
import { useAuth } from '../hooks/useAuth';
import { t } from '../i18n';
import ContextMenu from './ContextMenu';

// A picture's menu (utils/imageActions.js): Copy Image, Save Image, and Copy / Open Link (or
// Open Image for an encrypted attachment). `item` is a gallery item; `overViewer` when it's
// opened from the full-screen viewer. Right-clicking a picture opens it (PageMenus), and so
// does holding one in the viewer or a document on a phone.
export default function ImageMenu({ item, anchor, sheet, overViewer = false, onClose }) {
  const userId = useAuth()?.user?.id ?? null;
  return (
    <ContextMenu
      title={item.name || t('media.image.menuTitle')}
      label={item.name || t('media.image.menuTitle')}
      items={imageMenuItems(item, userId)}
      anchor={anchor}
      sheet={sheet}
      overViewer={overViewer}
      onClose={onClose}
    />
  );
}
