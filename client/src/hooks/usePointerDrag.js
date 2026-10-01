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
// onCancel(item); `canDrag(item)` (default yes) can turn dragging off for an item.
// With `onLongPress(item)`, a touch held still and lifted is a long press (a menu, like a
// message's), and a touch held still and then moved is a drag: holding arms it (a short
// vibration), lifting calls onLongPress (its click swallowed), moving starts the drag.
// `contextMenu(event)` keeps a long press from opening the browser's menu; it returns whether
// a touch is down (so a right-click handler can tell the two apart).
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
    const draggable = latest.current.canDrag?.(item) ?? true;
    const state = { item, pointerType: e.pointerType, startX: e.clientX, startY: e.clientY, dragging: false, armed: false };
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
          if (Math.hypot(dx, dy) <= TOUCH_SLOP_PX) return;
          // Moving after the hold (with a long press waiting): the drag starts here.
          if (state.armed && draggable) {
            state.armed = false;
            begin(ev.clientX, ev.clientY);
            return;
          }
          // Moving before the hold is up: it's a scroll, not a drag.
          finish();
          return;
        }
        if (!draggable || Math.hypot(dx, dy) < MOUSE_THRESHOLD_PX) return;
        begin(ev.clientX, ev.clientY);
        return;
      }
      latest.current.onMove?.(item, { x: ev.clientX, y: ev.clientY, dy });
    };
    // The click that follows lifting the finger or mouse doesn't reach what was under it.
    const swallowClick = () => {
      const swallow = (click) => { click.preventDefault(); click.stopPropagation(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    };
    state.onUp = (ev) => {
      const { dragging: wasDragging, armed: wasArmed } = state;
      finish();
      if (wasArmed) {
        swallowClick();
        latest.current.onLongPress?.(item);
        return;
      }
      if (!wasDragging) return;
      swallowClick();
      latest.current.onDrop?.(item, { x: ev.clientX, y: ev.clientY });
    };
    state.onCancel = () => {
      const wasDragging = state.dragging;
      finish();
      if (wasDragging) latest.current.onCancel?.(item);
    };
    state.onTouchMove = (ev) => {
      if (state.dragging || (state.armed && draggable)) ev.preventDefault();
    };
    if (state.pointerType === 'touch' && (draggable || latest.current.onLongPress)) {
      state.timer = setTimeout(() => {
        if (!latest.current.onLongPress) {
          begin(state.startX, state.startY);
          return;
        }
        state.armed = true;
        if (draggable) touchDrag = state;
        navigator.vibrate?.(10);
      }, TOUCH_HOLD_MS);
    }

    pending.current = state;
    window.addEventListener('pointermove', state.onMove);
    window.addEventListener('pointerup', state.onUp);
    window.addEventListener('pointercancel', state.onCancel);
    window.addEventListener('touchmove', state.onTouchMove, { passive: false });
  }, [finish]);

  const contextMenu = useCallback((e) => {
    if (pending.current?.pointerType !== 'touch') return false;
    e.preventDefault();
    return true;
  }, []);

  return { pointerDown, contextMenu };
}
