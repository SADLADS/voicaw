import { useEffect, useRef } from 'react';

const HOLD_MS = 450;
// A finger drifting further than this is scrolling, not holding.
const MOVE_TOLERANCE_PX = 10;

// Touch-and-hold on an element: returns props to spread on it. `onLongPress()` runs once the
// finger has been held still for HOLD_MS. The tap that ends a long press doesn't also count
// as a click (e.g. on a link or image in the message), and the browser's own long-press menu
// is suppressed. Scrolling or lifting the finger early cancels it.
export function useLongPress(onLongPress, { enabled = true } = {}) {
  const timer = useRef(null);
  const start = useRef(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => cancel, []);

  if (!enabled) return {};

  return {
    onTouchStart(e) {
      if (e.touches.length !== 1) return cancel();
      fired.current = false;
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        navigator.vibrate?.(10);
        callback.current();
      }, HOLD_MS);
    },
    onTouchMove(e) {
      if (!timer.current || !start.current) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onContextMenu(e) {
      // Android fires this on a long press; the message menu replaces it.
      e.preventDefault();
    },
    onClickCapture(e) {
      if (fired.current) {
        fired.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
