import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ImageViewerContext } from '../contexts';
import ImageViewer from './ImageViewer';

const HISTORY_MARK = 'voicawImageViewer';

// Holds the one open image viewer: `openImage({ images, index })` shows `images[index]` of a
// message's images (gallery items, see utils/imageGallery.js). Opening it adds a history entry, so the back button
// (Android's especially) closes the viewer instead of leaving the chat. The entry keeps the
// router's own state, so react-router sees going back to it as staying where it was.
export default function ImageViewerProvider({ children }) {
  const [gallery, setGallery] = useState(null);

  const openImage = useCallback((next) => {
    window.history.pushState({ ...window.history.state, [HISTORY_MARK]: true }, '');
    setGallery(next);
  }, []);

  const showIndex = useCallback((index) => setGallery((g) => g && { ...g, index }), []);

  const close = useCallback(() => {
    if (window.history.state?.[HISTORY_MARK]) window.history.back(); // popstate closes it
    else setGallery(null);
  }, []);

  useEffect(() => {
    if (!gallery) return undefined;
    const onPopState = () => {
      if (!window.history.state?.[HISTORY_MARK]) setGallery(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [gallery]);

  const value = useMemo(() => ({ openImage }), [openImage]);

  return (
    <ImageViewerContext.Provider value={value}>
      {children}
      {gallery && (
        <ImageViewer images={gallery.images} index={gallery.index} onIndexChange={showIndex} onClose={close} />
      )}
    </ImageViewerContext.Provider>
  );
}
