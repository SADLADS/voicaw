import { useEffect, useState } from 'react';

// Anything shorter than the window by more than this is the on-screen keyboard (smaller
// differences are browser toolbars).
const KEYBOARD_MIN_HEIGHT = 120;

// The part of the screen the user can actually see: shrinks when the on-screen keyboard is
// open. `offsetTop` is how far the browser scrolled the page to keep a focused input visible
// (iOS does this), so position:fixed content can line up with what's on screen. Values are
// not rounded: phones report fractional CSS pixels, and rounding leaves a visible seam.
function read() {
  const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
  const height = viewport ? viewport.height : window.innerHeight;
  return {
    height,
    offsetTop: viewport ? viewport.offsetTop : 0,
    keyboardOpen: window.innerHeight - height > KEYBOARD_MIN_HEIGHT,
  };
}

export function useVisualViewport(enabled = true) {
  const [size, setSize] = useState(read);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return undefined;
    const update = () => setSize(read());
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [enabled]);

  return size;
}
