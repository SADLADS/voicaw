import { useLayoutEffect, useRef } from 'react';
import { fitTileWidth } from '../voice/tileFit';

// Keeps `--camera-tile-width` on the returned ref's element at the size that fills it with
// `count` tiles (voice/tileFit.js), following its size.
export function useFittedTiles(count) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const fit = () => {
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      element.style.setProperty('--camera-tile-width', `${fitTileWidth({ width, height, count })}px`);
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);
  return ref;
}
