import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

const FLING_PX_PER_MS = 0.4; // a flick at least this fast goes its way, however short
const SNAP_PX = 60; // or a drag at least this long
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

// A bottom sheet the finger drags between its normal height (`collapsedHeight`) and full
// screen (the mobile emoji panel). Docked, an upward swipe anywhere on it pulls it up (the
// grid only scrolls once it's full screen); full screen, a downward swipe on its top bar, or
// on the grid when it's scrolled to the top, pulls it back down. The sheet follows the finger
// (`.sheet-dragging`, its height in `--sheet-height`), then settles (`.sheet-settling`) on
// whichever side a flick or a long enough drag points to, and `setExpanded` is called.
// Sideways swipes are left alone (the category bar scrolls sideways).
//
// The drag is decided on the touch's first move: that's when the browser decides whether it
// scrolls, so it's the last chance to keep it from scrolling.
export function useSheetDrag({ sheetRef, enabled, expanded, setExpanded, collapsedHeight }) {
  const latest = useRef({ expanded, setExpanded, collapsedHeight });
  latest.current = { expanded, setExpanded, collapsedHeight };

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!enabled || !sheet) return undefined;
    let touch = null;
    let timer = 0;

    const fullHeight = () => window.innerHeight;
    const paint = (height) => sheet.style.setProperty('--sheet-height', `${height}px`);
    const cleanUp = () => {
      sheet.classList.remove('sheet-dragging', 'sheet-settling');
      sheet.style.removeProperty('--sheet-height');
    };

    const settle = (open) => {
      sheet.classList.add('sheet-settling');
      paint(open ? fullHeight() : latest.current.collapsedHeight || sheet.offsetHeight);
      timer = setTimeout(() => {
        timer = 0;
        flushSync(() => latest.current.setExpanded(open));
        cleanUp();
      }, SETTLE_MS);
    };

    const onStart = (e) => {
      if (e.touches.length !== 1 || timer) {
        touch = null;
        return;
      }
      const { clientX: x, clientY: y } = e.touches[0];
      touch = {
        x, y, dragging: null,
        scroller: scrollerOf(e.target, sheet),
        startHeight: sheet.getBoundingClientRect().height,
        samples: [{ y, t: e.timeStamp }],
      };
    };

    const onMove = (e) => {
      if (!touch || e.touches.length !== 1) return;
      const { clientX: x, clientY: y } = e.touches[0];
      const dx = x - touch.x;
      const dy = y - touch.y;
      if (touch.dragging === null) {
        const open = latest.current.expanded;
        const scroller = touch.scroller;
        touch.dragging = e.cancelable && Math.abs(dy) > Math.abs(dx)
          && (open ? dy > 0 && (!scroller || scroller.scrollTop <= 0) : dy < 0);
        if (touch.dragging) sheet.classList.add('sheet-dragging');
      }
      if (!touch.dragging) return;
      e.preventDefault();
      const min = Math.min(latest.current.collapsedHeight || touch.startHeight, touch.startHeight);
      paint(Math.max(min, Math.min(fullHeight(), touch.startHeight - dy)));
      touch.samples = [...touch.samples, { y, t: e.timeStamp }].filter((s) => e.timeStamp - s.t < 100);
    };

    const onEnd = (e) => {
      const ended = touch;
      touch = null;
      if (!ended?.dragging) return;
      const open = latest.current.expanded;
      if (e.type === 'touchcancel') {
        settle(open);
        return;
      }
      const lastY = e.changedTouches[0]?.clientY ?? ended.y;
      const first = ended.samples[0];
      const elapsed = e.timeStamp - first.t;
      const velocity = elapsed > 0 ? (lastY - first.y) / elapsed : 0;
      const dy = lastY - ended.y;
      const up = Math.abs(velocity) > FLING_PX_PER_MS ? velocity < 0 : open ? dy < SNAP_PX : dy < -SNAP_PX;
      settle(up);
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
