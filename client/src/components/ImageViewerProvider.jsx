import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ImageViewerContext } from '../contexts';
import ImageViewer from './ImageViewer';

const HISTORY_MARK = 'voicawImageViewer';

// Holds the one open image viewer. Opening it adds a history entry, so the back button
// (Android's especially) closes the viewer instead of leaving the chat. The entry keeps the
// router's own state, so react-router sees going back to it as staying where it was.
export default function ImageViewerProvider({ children }) {
  const [image, setImage] = useState(null);

  const openImage = useCallback((next) => {
    window.history.pushState({ ...window.history.state, [HISTORY_MARK]: true }, '');
    setImage(next);
  }, []);

  const close = useCallback(() => {
    if (window.history.state?.[HISTORY_MARK]) window.history.back(); // popstate closes it
    else setImage(null);
  }, []);

  useEffect(() => {
    if (!image) return undefined;
    const onPopState = () => {
      if (!window.history.state?.[HISTORY_MARK]) setImage(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [image]);

  const value = useMemo(() => ({ openImage }), [openImage]);

  return (
    <ImageViewerContext.Provider value={value}>
      {children}
      {image && <ImageViewer key={image.src} image={image} onClose={close} />}
    </ImageViewerContext.Provider>
  );
}
