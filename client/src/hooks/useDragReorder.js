import { useCallback, useEffect, useRef, useState } from 'react';

const MOUSE_THRESHOLD_PX = 5;
const TOUCH_HOLD_MS = 350;
const TOUCH_SLOP_PX = 8;

// Reordering a vertical list by dragging (Discord's server list): a mouse drag starts after
// moving a few pixels, a touch drag after holding still for a moment (so a swipe still
// scrolls). The item follows the pointer, and `onReorder(newIds)` gets the new order on drop.
// Spread `itemProps(id)` on each item's element; `drag` is { id, dy, targetIndex } while
// dragging, for styling (the item at `targetIndex` is where it will land).
export function useDragReorder(ids, onReorder) {
  const [drag, setDrag] = useState(null);
  const elements = useRef(new Map());
  const pending = useRef(null);
  const latest = useRef({ ids, onReorder });
  latest.current = { ids, onReorder };

  // Where the dragged item would go: before the first other item whose middle is below it.
  const targetIndexAt = useCallback((id, y) => {
    const others = latest.current.ids.filter((other) => other !== id);
    let index = 0;
    for (const other of others) {
      const rect = elements.current.get(other)?.getBoundingClientRect();
      if (rect && y > rect.top + rect.height / 2) index += 1;
    }
    return index;
  }, []);

  const finish = useCallback(() => {
    const state = pending.current;
    pending.current = null;
    clearTimeout(state?.timer);
    window.removeEventListener('pointermove', state?.onMove);
    window.removeEventListener('pointerup', state?.onUp);
    window.removeEventListener('pointercancel', state?.onCancel);
    window.removeEventListener('touchmove', state?.onTouchMove);
  }, []);

  useEffect(() => finish, [finish]);

  const start = useCallback((state, y) => {
    state.dragging = true;
    setDrag({ id: state.id, dy: y - state.startY, targetIndex: targetIndexAt(state.id, y) });
    if (state.pointerType === 'touch') navigator.vibrate?.(10);
  }, [targetIndexAt]);

  const onPointerDown = useCallback((id, e) => {
    if (e.button !== 0 || latest.current.ids.length < 2) return;
    finish();
    const state = { id, pointerType: e.pointerType, startX: e.clientX, startY: e.clientY, dragging: false };

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
        start(state, ev.clientY);
        return;
      }
      setDrag({ id, dy, targetIndex: targetIndexAt(id, ev.clientY) });
    };
    state.onUp = (ev) => {
      const wasDragging = state.dragging;
      finish();
      setDrag(null);
      if (!wasDragging) return;
      // The click that follows the drop must not open the server.
      const swallow = (click) => { click.preventDefault(); click.stopPropagation(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);

      const { ids: current, onReorder: reorder } = latest.current;
      const next = current.filter((other) => other !== id);
      next.splice(targetIndexAt(id, ev.clientY), 0, id);
      if (next.some((other, i) => other !== current[i])) reorder(next);
    };
    state.onCancel = () => {
      finish();
      setDrag(null);
    };
    // While dragging by touch, the page mustn't scroll.
    state.onTouchMove = (ev) => {
      if (state.dragging) ev.preventDefault();
    };
    if (state.pointerType === 'touch') {
      state.timer = setTimeout(() => start(state, state.startY), TOUCH_HOLD_MS);
    }

    pending.current = state;
    window.addEventListener('pointermove', state.onMove);
    window.addEventListener('pointerup', state.onUp);
    window.addEventListener('pointercancel', state.onCancel);
    window.addEventListener('touchmove', state.onTouchMove, { passive: false });
  }, [finish, start, targetIndexAt]);

  const itemProps = useCallback((id) => ({
    ref: (el) => {
      if (el) elements.current.set(id, el);
      else elements.current.delete(id);
    },
    onPointerDown: (e) => onPointerDown(id, e),
    // A long press would otherwise open the browser's link menu.
    onContextMenu: (e) => { if (pending.current?.pointerType === 'touch') e.preventDefault(); },
  }), [onPointerDown]);

  return { drag, itemProps };
}
