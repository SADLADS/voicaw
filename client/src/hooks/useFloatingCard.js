import { useEffect, useLayoutEffect, useState } from 'react';

const MARGIN = 8;

// A person's card opened from a side list (the guild member list, a group DM's members): it
// floats over the chat, left of the list at the row's height; without room there (phones, where
// the list fills the screen) centred below the row. Kept in the window, and placed again when it
// grows or the window changes. A click outside the card and the rows, or Escape, calls
// `onClose`; dialogs don't count as outside. Returns the card's style: hidden until placed.
// `openId` is the open row's `data-user-id` inside `listRef`, `rowSelector` the rows' selector.
export function useFloatingCard(openId, { listRef, cardRef, rowSelector, onClose }) {
  const [position, setPosition] = useState(null);

  useEffect(() => {
    if (openId == null) return undefined;
    const onDown = (e) => {
      if (!cardRef.current?.contains(e.target) && !e.target.closest?.(`${rowSelector}, .vc-dialog-backdrop`)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openId, cardRef, rowSelector, onClose]);

  useLayoutEffect(() => {
    setPosition(null);
    if (openId == null) return undefined;
    const place = () => {
      const card = cardRef.current;
      const row = listRef.current?.querySelector(`${rowSelector}[data-user-id="${openId}"]`);
      if (!card || !row) return;
      const box = card.getBoundingClientRect();
      const list = listRef.current.getBoundingClientRect();
      const anchor = row.getBoundingClientRect();
      let left = list.left - box.width - MARGIN;
      let top = anchor.top;
      if (left < MARGIN) {
        left = Math.max(MARGIN, (window.innerWidth - box.width) / 2);
        top = anchor.bottom + MARGIN;
      }
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - box.height - MARGIN));
      setPosition({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (cardRef.current) observer?.observe(cardRef.current);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [openId, listRef, cardRef, rowSelector]);

  return position ?? { left: 0, top: 0, visibility: 'hidden' };
}
