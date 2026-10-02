const MARGIN = 8;

// Places a panel of size `box` by `anchor` (a rect): below it, or above when there's no room
// below; `beside` puts it to the anchor's right instead (a submenu), or its left when there's
// no room on the right. Kept on screen.
export function placeMenu(anchor, box, beside) {
  let left;
  let top;
  if (beside) {
    // The item sits inside its menu's padding (6px): clear that, plus a small gap.
    left = anchor.right + 10;
    if (left + box.width > window.innerWidth - MARGIN) left = anchor.left - box.width - 10;
    top = anchor.top - 6;
  } else {
    left = anchor.left;
    top = anchor.bottom + (anchor.bottom > anchor.top ? 6 : 0);
    if (top + box.height > window.innerHeight - MARGIN) top = anchor.top - box.height;
  }
  return {
    left: Math.max(MARGIN, Math.min(left, window.innerWidth - box.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, window.innerHeight - box.height - MARGIN)),
  };
}
