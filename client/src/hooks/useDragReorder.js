import { useCallback, useRef, useState } from 'react';
import { usePointerDrag } from './usePointerDrag';

// Reordering a vertical list by dragging (the guild rail), on usePointerDrag. The item
// follows the pointer, and `onReorder(newIds)` gets the new order on drop.
// Spread `itemProps(id)` on each item's element; `drag` is { id, dy, targetIndex } while
// dragging, for styling (the item at `targetIndex` is where it will land).
// `onMenu(id, anchor)` (optional) opens an item's menu: on a right-click (anchor: the pointer)
// or a touch held still and lifted (anchor: the item's rect); held and moved, it drags.
export function useDragReorder(ids, onReorder, { onMenu } = {}) {
  const [drag, setDrag] = useState(null);
  const elements = useRef(new Map());
  const latest = useRef({ ids, onReorder, onMenu });
  latest.current = { ids, onReorder, onMenu };
  const hasMenu = Boolean(onMenu);

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

  const { pointerDown, contextMenu } = usePointerDrag({
    canDrag: () => latest.current.ids.length >= 2,
    onLongPress: hasMenu ? (id) => {
      const rect = elements.current.get(id)?.getBoundingClientRect();
      latest.current.onMenu?.(id, rect ?? { left: 0, right: 0, top: 0, bottom: 0 });
    } : undefined,
    onStart: (id, { y, dy }) => setDrag({ id, dy, targetIndex: targetIndexAt(id, y) }),
    onMove: (id, { y, dy }) => setDrag({ id, dy, targetIndex: targetIndexAt(id, y) }),
    onCancel: () => setDrag(null),
    onDrop: (id, { y }) => {
      setDrag(null);
      const { ids: current, onReorder: reorder } = latest.current;
      const next = current.filter((other) => other !== id);
      next.splice(targetIndexAt(id, y), 0, id);
      if (next.some((other, i) => other !== current[i])) reorder(next);
    },
  });

  const itemProps = useCallback((id) => ({
    ref: (el) => {
      if (el) elements.current.set(id, el);
      else elements.current.delete(id);
    },
    onPointerDown: (e) => {
      if (latest.current.ids.length >= 2 || latest.current.onMenu) pointerDown(id, e);
    },
    onContextMenu: (e) => {
      // A touch held down: the long press (or drag) handles it, not the browser's link menu.
      if (contextMenu(e) || !latest.current.onMenu) return;
      e.preventDefault();
      latest.current.onMenu(id, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
    },
  }), [pointerDown, contextMenu]);

  return { drag, itemProps };
}
