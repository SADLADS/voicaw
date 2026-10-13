import { useEffect, useRef } from 'react';

const FLING_PX_PER_MS = 0.4; // a downward flick at least this fast closes it, however short
const CLOSE_FRACTION = 0.25; // or a drag past this much of its height
const SETTLE_MS = 200; // matches the `.sheet-settling` transition

// The scrollable element (between `el` and `stop`) a touch on `el` would scroll, if any.
function scrollerOf(el, stop) {
  for (let node = el; node && node !== stop; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight + 1) continue;
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
}

// A full-screen sheet on a phone (the full profile, UserProfile) that a downward swipe closes:
// anywhere on it while what's under the finger is scrolled to the top. It follows the finger
// (`.sheet-dragging`, moved by `--sheet-offset`), then either slides away and `onClose` is
// called (a flick down, or dragged past a quarter of its height) or springs back
// (`.sheet-settling`). Like the emoji panel's (useSheetDrag), but closing instead of shrinking.
// The drag is decided on the touch's first move, the browser's last chance not to scroll.
export function useSheetDismiss({ sheetRef, enabled, onClose }) {
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!enabled || !sheet) return undefined;
    let touch = null;
    let timer = 0;

    const paint = (offset) => sheet.style.setProperty('--sheet-offset', `${offset}px`);
    const cleanUp = () => {
      sheet.classList.remove('sheet-dragging', 'sheet-settling');
      sheet.style.removeProperty('--sheet-offset');
    };
    const settle = (close) => {
      sheet.classList.add('sheet-settling');
      paint(close ? sheet.offsetHeight : 0);
      timer = setTimeout(() => {
        timer = 0;
        if (close) latest.current();
        else cleanUp();
      }, SETTLE_MS);
    };

    const onStart = (e) => {
      if (e.touches.length !== 1 || timer) {
        touch = null;
        return;
      }
      const { clientX: x, clientY: y } = e.touches[0];
      touch = { x, y, dragging: null, scroller: scrollerOf(e.target, sheet), samples: [{ y, t: e.timeStamp }] };
    };

    const onMove = (e) => {
      if (!touch || e.touches.length !== 1) return;
      const { clientX: x, clientY: y } = e.touches[0];
      const dx = x - touch.x;
      const dy = y - touch.y;
      if (touch.dragging === null) {
        const atTop = !touch.scroller || touch.scroller.scrollTop <= 0;
        touch.dragging = e.cancelable && dy > 0 && Math.abs(dy) > Math.abs(dx) && atTop;
        if (touch.dragging) sheet.classList.add('sheet-dragging');
      }
      if (!touch.dragging) return;
      e.preventDefault();
      paint(Math.max(0, dy));
      touch.samples = [...touch.samples, { y, t: e.timeStamp }].filter((s) => e.timeStamp - s.t < 100);
    };

    const onEnd = (e) => {
      const ended = touch;
      touch = null;
      if (!ended?.dragging) return;
      if (e.type === 'touchcancel') return settle(false);
      const lastY = e.changedTouches[0]?.clientY ?? ended.y;
      const first = ended.samples[0];
      const elapsed = e.timeStamp - first.t;
      const velocity = elapsed > 0 ? (lastY - first.y) / elapsed : 0;
      const dy = lastY - ended.y;
      settle(velocity > FLING_PX_PER_MS || dy > sheet.offsetHeight * CLOSE_FRACTION);
    };

    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd);
    sheet.addEventListener('touchcancel', onEnd);
    return () => {
      clearTimeout(timer);
      cleanUp();
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
      sheet.removeEventListener('touchcancel', onEnd);
    };
  }, [sheetRef, enabled]);
}
