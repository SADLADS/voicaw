import React from 'react';
import { useAttachmentSrc } from '../../hooks/useAttachmentSrc';
import { galleryItemFromUrl, galleryItemRef } from '../../utils/imageGallery';

// A document's cover image as a banner (cropped to its box): on feed cards, over the document
// and in the editor. Nothing without a cover; a soft placeholder while it decrypts. Its menu
// (copy, save...) opens by right-clicking it, or holding it on a phone (useImageHold).
export default function DocumentCover({ cover, className = '' }) {
  const { src, failed, external } = useAttachmentSrc(cover);
  if (!cover) return null;
  return (
    <div className={`document-cover ${className}${src ? '' : ' loading'}`} aria-hidden={!src}>
      {src && !failed && (
        <img
          ref={galleryItemRef(galleryItemFromUrl(cover, 'Cover image'))}
          data-gallery-item=""
          src={src}
          alt=""
          draggable={false}
          referrerPolicy={external ? 'no-referrer' : undefined}
        />
      )}
    </div>
  );
}
