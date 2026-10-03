import { useEffect, useRef } from 'react';
import { scrollsSideways } from './useSwipePanes';
import { isTouchDragging } from './usePointerDrag';

const DECIDE_PX = 8; // movement before a touch is judged sideways or not (as the panes)
export const REPLY_PX = 64; // pulled at least this far left when let go: a reply
const RESISTANCE = 0.3; // past REPLY_PX the message follows the finger this much
// Touches that start in these keep their own gestures (the inline editor, sliders, videos).
const NO_SWIPE = 'input, textarea, [contenteditable="true"], video, .inline-edit-wrapper, [data-no-pane-swipe]';

// How far the message moves for a finger `dx` px from where the swipe was decided (left only).
export function swipeOffset(dx) {
  const pull = Math.max(0, -dx);
  return pull <= REPLY_PX ? pull : REPLY_PX + (pull - REPLY_PX) * RESISTANCE;
}

function paint(row, px) {
  if (!px) delete row.dataset.swipe; // springs back (a transition in mobile.css)
  row.style.transform = px ? `translate3d(${-px}px, 0, 0)` : '';
  if (px) row.style.setProperty('--swipe-progress', String(Math.min(px / REPLY_PX, 1)));
  else row.style.removeProperty('--swipe-progress');
}

// Phones: swiping a message to the left replies to it, like Discord. One listener on the
// message list (`scrollerRef`); the message follows the finger with the reply arrow showing
// behind it (`.swipe-reply-icon`), a short vibration says it's far enough, and letting go
// there calls `onReply(key)` (the row's data-key). A swipe only counts once it's clearly
// sideways and leftwards, so scrolling is untouched and a rightward swipe stays the panes'
// (useSwipePanes: back to the list). `canReply(key)` can refuse a row (still sending, a
// notice). The row only has a transform while moving.
export function useSwipeToReply(scrollerRef, { enabled, canReply, onReply }) {
  const latest = useRef({ canReply, onReply });
  latest.current = { canReply, onReply };

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || !scroller) return undefined;
    let touch = null; // { id, x0, y0, row, key, decided, armed }

    const onStart = (e) => {
      touch = null;
      if (e.touches.length !== 1 || e.target.closest?.(NO_SWIPE) || e.target.closest?.('.panes-moving')) return;
      const row = e.target.closest?.('.each-dm-message-wrapper');
      const key = row?.closest('[data-key]')?.dataset.key;
      if (!row || !key || !scroller.contains(row)) return;
      const t = e.touches[0];
      touch = { id: t.identifier, x0: t.clientX, y0: t.clientY, row, key, decided: false, armed: false };
    };

    const onMove = (e) => {
      if (!touch) return;
      const t = [...e.touches].find((each) => each.identifier === touch.id);
      if (!t) return;
      const dx = t.clientX - touch.x0;
      const dy = t.clientY - touch.y0;
      if (!touch.decided) {
        if (Math.hypot(dx, dy) < DECIDE_PX) return;
        const sideways = Math.abs(dx) > Math.abs(dy) * 1.2;
        if (!sideways || dx > 0 || !e.cancelable || isTouchDragging()
          || scrollsSideways(e.target, scroller, dx) || !latest.current.canReply(touch.key)) {
          touch = null;
          return;
        }
        touch.decided = true;
        touch.x0 = t.clientX; // no jump by the few pixels it took to decide
        touch.row.dataset.swipe = 'moving';
      }
      e.preventDefault();
      const px = swipeOffset(t.clientX - touch.x0);
      const armed = px >= REPLY_PX;
      if (armed && !touch.armed) navigator.vibrate?.(10);
      touch.armed = armed;
      touch.row.dataset.swipe = armed ? 'armed' : 'moving';
      paint(touch.row, px);
    };

    const onEnd = (e) => {
      if (!touch) return;
      if ([...e.touches].some((each) => each.identifier === touch.id)) return;
      const { decided, armed, row, key } = touch;
      touch = null;
      if (!decided) return;
      paint(row, 0);
      if (armed && e.type === 'touchend') latest.current.onReply(key);
    };

    scroller.addEventListener('touchstart', onStart, { passive: true });
    scroller.addEventListener('touchmove', onMove, { passive: false });
    scroller.addEventListener('touchend', onEnd);
    scroller.addEventListener('touchcancel', onEnd);
    return () => {
      scroller.removeEventListener('touchstart', onStart);
      scroller.removeEventListener('touchmove', onMove);
      scroller.removeEventListener('touchend', onEnd);
      scroller.removeEventListener('touchcancel', onEnd);
      if (touch?.decided) paint(touch.row, 0);
      touch = null;
    };
  }, [enabled, scrollerRef]);
}
