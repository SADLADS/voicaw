import { useEffect, useRef } from 'react';
import { scrollsSideways } from './useSwipePanes';

const DECIDE_PX = 8; // movement before a touch is judged sideways or not
const FLING_PX_PER_MS = 0.35; // a flick at least this fast closes, however short
const CLOSE_SHARE = 0.35; // or a drag past this share of the width
const SETTLE_MS = 200; // matches the `.swipe-settling` transition

// A full-screen panel on a phone (the guild member list) that a swipe to the right drags away
// and closes, like the chat sliding back to the list (useSwipePanes, which leaves touches on
// the panel alone). Only rightward: a leftward swipe opens nothing (it replies to a message).
// The panel follows the finger (`transform`), then settles (`.swipe-settling`) off to the
// right, calling `onClose`, or back in place, by how far and how fast it went.
export function useSwipeToClose(ref, { enabled, onClose }) {
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return undefined;
    let touch = null;
    let timer = 0;

    const paint = (x) => {
      el.style.transform = x ? `translate3d(${x}px, 0, 0)` : '';
    };
    const settle = (close) => {
      el.classList.add('swipe-settling');
      paint(close ? el.clientWidth : 0);
      timer = setTimeout(() => {
        timer = 0;
        el.classList.remove('swipe-settling');
        if (close) latest.current?.();
        else paint(0);
      }, SETTLE_MS);
    };

    const onStart = (e) => {
      if (e.touches.length !== 1 || timer) {
        touch = null;
        return;
      }
      const { clientX: x, clientY: y } = e.touches[0];
      touch = { x, y, target: e.target, dragging: null, dx: 0, samples: [{ x, t: e.timeStamp }] };
    };

    const onMove = (e) => {
      if (!touch || e.touches.length !== 1) return;
      const { clientX: x, clientY: y } = e.touches[0];
      const dx = x - touch.x;
      const dy = y - touch.y;
      if (touch.dragging === null) {
        if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
        touch.dragging = e.cancelable && dx > Math.abs(dy) && !scrollsSideways(touch.target, el, dx);
        if (!touch.dragging) {
          touch = null;
          return;
        }
      }
      e.preventDefault();
      touch.dx = Math.max(0, dx);
      touch.samples.push({ x, t: e.timeStamp });
      if (touch.samples.length > 8) touch.samples.shift();
      paint(touch.dx);
    };

    const onEnd = () => {
      if (!touch?.dragging) {
        touch = null;
        return;
      }
      // Speed over the last ~100ms (px/ms), as in useSwipePanes.
      const last = touch.samples.at(-1);
      const first = touch.samples.find((s) => last.t - s.t <= 100);
      const speed = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      const close = speed > FLING_PX_PER_MS || (speed > -FLING_PX_PER_MS && touch.dx > el.clientWidth * CLOSE_SHARE);
      touch = null;
      settle(close);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      clearTimeout(timer);
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.classList.remove('swipe-settling');
      paint(0);
    };
  }, [ref, enabled]);
}
