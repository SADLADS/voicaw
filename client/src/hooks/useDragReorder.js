import { useCallback, useRef, useState } from 'react';
import { usePointerDrag } from './usePointerDrag';

// Reordering a vertical list by dragging (Discord's server list), on usePointerDrag. The item
// follows the pointer, and `onReorder(newIds)` gets the new order on drop.
// Spread `itemProps(id)` on each item's element; `drag` is { id, dy, targetIndex } while
// dragging, for styling (the item at `targetIndex` is where it will land).
export function useDragReorder(ids, onReorder) {
  const [drag, setDrag] = useState(null);
  const elements = useRef(new Map());
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

  const { pointerDown, contextMenu } = usePointerDrag({
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
      if (latest.current.ids.length >= 2) pointerDown(id, e);
    },
    // A long press would otherwise open the browser's link menu.
    onContextMenu: contextMenu,
  }), [pointerDown, contextMenu]);

  return { drag, itemProps };
}
