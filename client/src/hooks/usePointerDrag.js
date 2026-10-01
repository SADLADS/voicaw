import { useCallback, useEffect, useRef } from 'react';

const MOUSE_THRESHOLD_PX = 5;
const TOUCH_HOLD_MS = 350;
const TOUCH_SLOP_PX = 8;

// A touch drag in progress anywhere, so the phone's pane swipe (useSwipePanes) leaves it alone.
let touchDrag = null;
export const isTouchDragging = () => touchDrag !== null;

// The pointer side of dragging things around (useDragReorder builds a list on it): a mouse
// drag starts after moving a few pixels, a touch drag after holding still for a moment (so a
// swipe still scrolls), the page doesn't scroll while a touch drag is on, and the click that
// follows a drop doesn't reach what was dragged (so dropping a link doesn't open it).
//
// Call `pointerDown(item, event)` from an element's onPointerDown. `handlers` (read when
// needed) get: onStart(item, { x, y, dy }), onMove(item, { x, y, dy }), onDrop(item, { x, y }),
// onCancel(item). `contextMenu(event)` keeps a long press from opening the browser's menu.
export function usePointerDrag(handlers) {
  const pending = useRef(null);
  const latest = useRef(handlers);
  latest.current = handlers;

  const finish = useCallback(() => {
    const state = pending.current;
    pending.current = null;
    if (touchDrag === state) touchDrag = null;
    clearTimeout(state?.timer);
    window.removeEventListener('pointermove', state?.onMove);
    window.removeEventListener('pointerup', state?.onUp);
    window.removeEventListener('pointercancel', state?.onCancel);
    window.removeEventListener('touchmove', state?.onTouchMove);
  }, []);

  useEffect(() => finish, [finish]);

  const pointerDown = useCallback((item, e) => {
    if (e.button !== 0) return;
    finish();
    const state = { item, pointerType: e.pointerType, startX: e.clientX, startY: e.clientY, dragging: false };
    const begin = (x, y) => {
      state.dragging = true;
      if (state.pointerType === 'touch') touchDrag = state;
      latest.current.onStart?.(item, { x, y, dy: y - state.startY });
      if (state.pointerType === 'touch') navigator.vibrate?.(10);
    };

    state.onMove = (ev) => {
      const dx = ev.clientX - state.startX;
      const dy = ev.clientY - state.startY;
      if (!state.dragging) {
        if (state.pointerType === 'touch') {
          // Moving before the hold is up: it's a scroll, not a drag.
          if (Math.hypot(dx, dy) > TOUCH_SLOP_PX) finish();
          return;
        }
        if (Math.hypot(dx, dy) < MOUSE_THRESHOLD_PX) return;
        begin(ev.clientX, ev.clientY);
        return;
      }
      latest.current.onMove?.(item, { x: ev.clientX, y: ev.clientY, dy });
    };
    state.onUp = (ev) => {
      const wasDragging = state.dragging;
      finish();
      if (!wasDragging) return;
      const swallow = (click) => { click.preventDefault(); click.stopPropagation(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      latest.current.onDrop?.(item, { x: ev.clientX, y: ev.clientY });
    };
    state.onCancel = () => {
      const wasDragging = state.dragging;
      finish();
      if (wasDragging) latest.current.onCancel?.(item);
    };
    state.onTouchMove = (ev) => {
      if (state.dragging) ev.preventDefault();
    };
    if (state.pointerType === 'touch') {
      state.timer = setTimeout(() => begin(state.startX, state.startY), TOUCH_HOLD_MS);
    }

    pending.current = state;
    window.addEventListener('pointermove', state.onMove);
    window.addEventListener('pointerup', state.onUp);
    window.addEventListener('pointercancel', state.onCancel);
    window.addEventListener('touchmove', state.onTouchMove, { passive: false });
  }, [finish]);

  const contextMenu = useCallback((e) => {
    if (pending.current?.pointerType === 'touch') e.preventDefault();
  }, []);

  return { pointerDown, contextMenu };
}
