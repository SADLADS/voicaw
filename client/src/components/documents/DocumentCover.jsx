import React from 'react';
import { useAttachmentSrc } from '../../hooks/useAttachmentSrc';

// A document's cover image as a banner (cropped to its box): on feed cards, over the document
// and in the editor. Nothing without a cover; a soft placeholder while it decrypts.
export default function DocumentCover({ cover, className = '' }) {
  const { src, failed, external } = useAttachmentSrc(cover);
  if (!cover) return null;
  return (
    <div className={`document-cover ${className}${src ? '' : ' loading'}`} aria-hidden={!src}>
      {src && !failed && (
        <img src={src} alt="" draggable={false} referrerPolicy={external ? 'no-referrer' : undefined} />
      )}
    </div>
  );
}
