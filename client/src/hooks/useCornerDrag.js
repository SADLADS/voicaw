import { useCallback, useEffect, useRef, useState } from 'react';

// The corner players (Layout's .corner-players: a watched stream, Watch Together's mini
// player) are dragged as one, from anywhere on them but their controls, and snap to the
// nearest of the screen's four corners when let go, like Discord's picture in picture. The
// corner is kept on this device (localStorage pipCorner).
export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const KEY = 'pipCorner';
// Under this, it's a click, not a drag.
const DRAG_FROM = 6;
// What's dragged: the small players, not a docked or full-screen one, nor their controls.
const HANDLES = '.stream-view.corner, .watch-party-player.mini';
const NOT_HANDLES = 'button, input, select, textarea, a, [role="slider"]';

function load() {
  try {
    const stored = localStorage.getItem(KEY);
    return CORNERS.includes(stored) ? stored : null;
  } catch {
    return null;
  }
}

function save(corner) {
  try {
    localStorage.setItem(KEY, corner);
  } catch {
    // Not kept: fine.
  }
}

// The corner nearest a box's middle, in a `width` × `height` screen.
export function cornerFor(rect, width, height) {
  const y = rect.top + rect.height / 2 < height / 2 ? 'top' : 'bottom';
  const x = rect.left + rect.width / 2 < width / 2 ? 'left' : 'right';
  return `${y}-${x}`;
}

// Swallows the click that ends a drag (it would press whatever it ends over).
function swallowNextClick() {
  const swallow = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

// `ref` goes on the corner players' box, `onPointerDown` too. `corner` is where it sits
// (`fallback` until someone drags it), `dragging` while it follows the pointer. `areaRef`: the
// page's content pane, whose left edge the left corners keep to (--vc-pip-left), so they never
// cover the rail, the channel list or the voice bar and user panel under it.
export function useCornerDrag(fallback, areaRef) {
  const [stored, setStored] = useState(load);
  const [dragging, setDragging] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const area = areaRef?.current;
    if (!area) return undefined;
    const follow = () => ref.current?.style.setProperty('--vc-pip-left', `${Math.max(0, area.getBoundingClientRect().left)}px`);
    follow();
    // Its left edge moves when the sidebar is resized or a page drops its column (the pane
    // changes size), or the window does.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    observer?.observe(area);
    window.addEventListener('resize', follow);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', follow);
    };
  }, [areaRef]);

  const onPointerDown = useCallback((e) => {
    const box = ref.current;
    if (!box || e.button !== 0 || !e.isPrimary) return;
    if (!e.target.closest(HANDLES) || e.target.closest(NOT_HANDLES)) return;
    // Not text selection or the video's own dragging.
    e.preventDefault();
    const start = box.getBoundingClientRect();
    const { clientX: x0, clientY: y0, pointerId } = e;
    let moved = false;
    box.setPointerCapture?.(pointerId);

    const move = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved) {
        if (Math.hypot(dx, dy) < DRAG_FROM) return;
        moved = true;
        setDragging(true);
      }
      const left = Math.min(Math.max(start.left + dx, 0), Math.max(0, window.innerWidth - start.width));
      const top = Math.min(Math.max(start.top + dy, 0), Math.max(0, window.innerHeight - start.height));
      Object.assign(box.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    };
    const end = (ev) => {
      if (ev.pointerId !== pointerId) return;
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', end);
      box.removeEventListener('pointercancel', end);
      box.releasePointerCapture?.(pointerId);
      if (!moved) return;
      const next = cornerFor(box.getBoundingClientRect(), window.innerWidth, window.innerHeight);
      Object.assign(box.style, { left: '', top: '', right: '', bottom: '' });
      setStored(next);
      save(next);
      setDragging(false);
      if (ev.type === 'pointerup') swallowNextClick();
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }, []);

  return { ref, corner: stored ?? fallback, dragging, onPointerDown };
}
