import { useEffect, useState } from 'react';
import { loadImageSrc, readyImageSrc } from '../utils/imageGallery';

// A gallery item's displayable URL: { src, error }. `src` is null while it decrypts. With
// `preview`, an image's thumbnail will do (utils/imageGallery.js).
export function useImageSrc(item, preview = false) {
  const [state, setState] = useState(() => ({ item, src: readyImageSrc(item, preview), error: false }));
  const current = state.item === item ? state : { item, src: readyImageSrc(item, preview), error: false };
  if (current !== state) setState(current);

  useEffect(() => {
    if (current.src) return undefined;
    let cancelled = false;
    loadImageSrc(item, preview).then(
      (src) => !cancelled && setState({ item, src, error: false }),
      () => !cancelled && setState({ item, src: null, error: true })
    );
    return () => { cancelled = true; };
  }, [item, current.src, preview]);

  return current;
}
