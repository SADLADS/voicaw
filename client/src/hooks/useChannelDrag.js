import { useCallback, useRef, useState } from 'react';
import { usePointerDrag } from './usePointerDrag';

// Dragging channels and categories into a new order in the channel list (GuildSidebar), like
// Discord: a channel can go anywhere, into another category or above them all; a category
// moves with its channels. The dragged row follows the pointer and a line shows where it will
// land. On drop the layout changes at once (`onLayout(guild)`) and is saved with `save(move)`;
// the server's `guild_update` then settles it (a failed save: `onError`).
//
// The rows are found in the DOM, in order, inside the element `listRef` points at:
// `[data-drag-row="channel"][data-id][data-category]` (data-category empty: no category),
// `[data-drag-row="category"][data-id]` (a category's header) and
// `[data-category-block][data-id]` (a category with its channels). `drag` is
// { kind, id, dy, lineTop } while dragging (lineTop: where to draw the line, in the list's
// scrolled coordinates).

const EDGE_PX = 32;
const EDGE_SCROLL_PX = 12;

// Where a dragged channel lands for pointer height `y`, given the other rows in order
// ([{ kind: 'channel' | 'category', id, categoryId, top, bottom }]): before the first row
// whose middle is below the pointer. Before a channel means joining its category; before a
// category's header means the end of whatever comes above. Returns { categoryId, beforeId,
// lineY }.
export function channelDropTarget(rows, y) {
  const sectionOf = (row) => (row ? (row.kind === 'category' ? row.id : row.categoryId) : null);
  const index = rows.findIndex((row) => y < (row.top + row.bottom) / 2);
  if (index < 0) {
    const last = rows[rows.length - 1];
    return { categoryId: sectionOf(last), beforeId: null, lineY: last?.bottom ?? 0 };
  }
  const row = rows[index];
  if (row.kind === 'channel') return { categoryId: row.categoryId, beforeId: row.id, lineY: row.top };
  return { categoryId: sectionOf(rows[index - 1]), beforeId: null, lineY: row.top };
}

// Where a dragged category lands: before the first other category whose header's middle is
// below the pointer, else last. `blocks` are the other categories [{ id, top, headerMiddle,
// bottom }] in order. Returns { beforeId, lineY }.
export function categoryDropTarget(blocks, y) {
  const next = blocks.find((block) => y < block.headerMiddle);
  if (next) return { beforeId: next.id, lineY: next.top };
  return { beforeId: null, lineY: blocks[blocks.length - 1]?.bottom ?? 0 };
}

const byPosition = (a, b) => a.position - b.position || a.id - b.id;

// The guild's layout with a channel moved (as the server does it): into `categoryId`, before
// `beforeId`, or at the end of that category. Positions are renumbered.
export function applyChannelMove(guild, channelId, { categoryId, beforeId }) {
  const moving = guild.channels.find((c) => c.id === channelId);
  if (!moving) return guild;
  const rest = [...guild.channels].sort(byPosition).filter((c) => c.id !== channelId);
  let at = beforeId != null ? rest.findIndex((c) => c.id === beforeId) : -1;
  if (at < 0) {
    const last = rest.map((c) => c.category_id ?? null).lastIndexOf(categoryId ?? null);
    at = last < 0 ? rest.length : last + 1;
  }
  rest.splice(at, 0, { ...moving, category_id: categoryId ?? null });
  return { ...guild, channels: rest.map((c, position) => ({ ...c, position })) };
}

export function applyCategoryMove(guild, categoryId, { beforeId }) {
  const moving = guild.categories.find((c) => c.id === categoryId);
  if (!moving) return guild;
  const rest = [...guild.categories].sort(byPosition).filter((c) => c.id !== categoryId);
  const at = beforeId != null ? rest.findIndex((c) => c.id === beforeId) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, moving);
  return { ...guild, categories: rest.map((c, position) => ({ ...c, position })) };
}

// Whether a move would change anything.
function channelMoveChanges(guild, channelId, move) {
  const next = applyChannelMove(guild, channelId, move);
  const order = (g) => [...g.channels].sort(byPosition).map((c) => `${c.id}:${c.category_id ?? ''}`).join();
  return order(next) !== order(guild);
}

function categoryMoveChanges(guild, categoryId, move) {
  const order = (g) => [...g.categories].sort(byPosition).map((c) => c.id).join();
  return order(applyCategoryMove(guild, categoryId, move)) !== order(guild);
}

export function useChannelDrag({ guild, enabled, onLayout, save, onError }) {
  const [drag, setDrag] = useState(null);
  const listRef = useRef(null);
  const latest = useRef({ guild, onLayout, save, onError });
  latest.current = { guild, onLayout, save, onError };

  // The drop target for the pointer at `y` while dragging `item` ({ kind, id }).
  const targetAt = useCallback((item, y) => {
    const list = listRef.current;
    if (!list) return null;
    const rect = (el) => el.getBoundingClientRect();
    if (item.kind === 'channel') {
      const rows = [...list.querySelectorAll('[data-drag-row]')]
        .filter((el) => !(el.dataset.dragRow === 'channel' && Number(el.dataset.id) === item.id))
        .map((el) => ({
          kind: el.dataset.dragRow,
          id: Number(el.dataset.id),
          categoryId: el.dataset.category ? Number(el.dataset.category) : null,
          top: rect(el).top,
          bottom: rect(el).bottom,
        }));
      return channelDropTarget(rows, y);
    }
    const blocks = [...list.querySelectorAll('[data-category-block]')]
      .filter((el) => Number(el.dataset.id) !== item.id)
      .map((el) => {
        const header = rect(el.querySelector('[data-drag-row="category"]') ?? el);
        return { id: Number(el.dataset.id), top: rect(el).top, bottom: rect(el).bottom, headerMiddle: (header.top + header.bottom) / 2 };
      });
    return categoryDropTarget(blocks, y);
  }, []);

  const show = useCallback((item, { y, dy }) => {
    const list = listRef.current;
    if (!list) return;
    // Near the top or bottom edge, the list scrolls.
    const box = list.getBoundingClientRect();
    if (y < box.top + EDGE_PX) list.scrollTop -= EDGE_SCROLL_PX;
    else if (y > box.bottom - EDGE_PX) list.scrollTop += EDGE_SCROLL_PX;
    const target = targetAt(item, y);
    setDrag({ ...item, dy, lineTop: target ? target.lineY - box.top + list.scrollTop : null });
  }, [targetAt]);

  const { pointerDown, contextMenu } = usePointerDrag({
    onStart: show,
    onMove: show,
    onCancel: () => setDrag(null),
    onDrop: async (item, { y }) => {
      const target = targetAt(item, y);
      setDrag(null);
      const { guild: current, onLayout: apply, save: persist, onError: fail } = latest.current;
      if (!target || !current) return;
      let move;
      if (item.kind === 'channel') {
        move = { kind: 'channel', id: item.id, categoryId: target.categoryId, beforeId: target.beforeId };
        if (!channelMoveChanges(current, item.id, move)) return;
        apply(applyChannelMove(current, item.id, move));
      } else {
        move = { kind: 'category', id: item.id, beforeId: target.beforeId };
        if (!categoryMoveChanges(current, item.id, move)) return;
        apply(applyCategoryMove(current, item.id, move));
      }
      try {
        await persist(move);
      } catch (err) {
        fail?.(err);
      }
    },
  });

  // Spread on a draggable row (a channel's or a category header's element).
  const dragProps = useCallback((kind, id) => (enabled ? {
    onPointerDown: (e) => pointerDown({ kind, id }, e),
    onContextMenu: contextMenu,
  } : {}), [enabled, pointerDown, contextMenu]);

  return { drag, listRef, dragProps };
}
