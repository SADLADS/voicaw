import { useCallback, useRef, useState } from 'react';
import { usePointerDrag } from './usePointerDrag';
import { applyDrop, dropTarget, rowKey } from '../utils/guildFolders';

// Dragging guilds and folders in the rail (utils/guildFolders.js), on usePointerDrag: between
// items, a guild onto another to make a folder, into a folder or out of one, a folder whole.
// `rail` is the rail's items, `openIds` the open folders' ids; `onChange(items)` gets the new
// items on drop. Items are known by their row key (rowKey: 'g:<id>', 'f:<id>').
// Spread `rowProps(key)` on each guild's row and each folder's top (its icon), and give each
// folder's whole element (top and open guilds) `groupRef(id)`. `drag` is { key, dy, target }
// while dragging (dropTarget's target, for drawing where it would land).
// `onMenu(key, anchor)` opens an item's menu: on a right-click (anchor: the pointer) or a touch
// held still and lifted (anchor: the row's rect); held and moved, it drags.
export function useRailDrag(rail, openIds, onChange, { onMenu } = {}) {
  const [drag, setDrag] = useState(null);
  const rows = useRef(new Map());
  const groups = useRef(new Map());
  const latest = useRef({ rail, openIds, onChange, onMenu });
  latest.current = { rail, openIds, onChange, onMenu };
  const guildCount = rail.reduce((n, item) => n + (item.type === 'folder' ? item.guilds.length : 1), 0);
  const canDrag = guildCount >= 2;

  // The rows the dragged item could land between, as drawn now (see dropTarget).
  const rowsFor = useCallback((key) => {
    const draggingFolder = key.startsWith('f:');
    const result = [];
    const add = (rowKeyValue, element, row) => {
      const rect = element?.getBoundingClientRect();
      if (rect) result.push({ key: rowKeyValue, top: rect.top, bottom: rect.bottom, ...row });
    };
    for (const item of latest.current.rail) {
      const itemKey = rowKey(item.type, item.id);
      if (itemKey === key) continue;
      if (item.type === 'guild') {
        add(itemKey, rows.current.get(itemKey), { type: 'guild', id: item.id });
        continue;
      }
      const open = latest.current.openIds.has(item.id);
      if (draggingFolder) {
        add(itemKey, groups.current.get(item.id), { type: 'folder', id: item.id, open });
        continue;
      }
      add(itemKey, rows.current.get(itemKey), { type: 'folder', id: item.id, open });
      if (!open) continue;
      for (const guild of item.guilds) {
        const guildKey = rowKey('guild', guild.id);
        if (guildKey !== key) add(guildKey, rows.current.get(guildKey), { type: 'guild', id: guild.id, folderId: item.id });
      }
    }
    return result;
  }, []);

  const targetAt = useCallback((key, y) => dropTarget(rowsFor(key), y, { folder: key.startsWith('f:') }), [rowsFor]);

  const { pointerDown, contextMenu } = usePointerDrag({
    canDrag: () => canDrag,
    onLongPress: onMenu ? (key) => {
      const rect = rows.current.get(key)?.getBoundingClientRect();
      latest.current.onMenu?.(key, rect ?? { left: 0, right: 0, top: 0, bottom: 0 });
    } : undefined,
    onStart: (key, { y, dy }) => setDrag({ key, dy, target: targetAt(key, y) }),
    onMove: (key, { y, dy }) => setDrag({ key, dy, target: targetAt(key, y) }),
    onCancel: () => setDrag(null),
    onDrop: (key, { y }) => {
      setDrag(null);
      const next = applyDrop(latest.current.rail, key, targetAt(key, y));
      if (next) latest.current.onChange(next);
    },
  });

  const rowProps = useCallback((key) => ({
    ref: (el) => {
      if (el) rows.current.set(key, el);
      else rows.current.delete(key);
    },
    onPointerDown: (e) => {
      if (canDrag || latest.current.onMenu) pointerDown(key, e);
    },
    onContextMenu: (e) => {
      // A touch held down: the long press (or drag) handles it, not the browser's link menu.
      if (contextMenu(e) || !latest.current.onMenu) return;
      e.preventDefault();
      latest.current.onMenu(key, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
    },
  }), [canDrag, pointerDown, contextMenu]);

  const groupRef = useCallback((id) => (el) => {
    if (el) groups.current.set(id, el);
    else groups.current.delete(id);
  }, []);

  return { drag, rowProps, groupRef };
}
