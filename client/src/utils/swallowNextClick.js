// Swallows the click that follows lifting a finger or the mouse, so it doesn't press whatever
// is under it (something that has just closed or moved out of the way). On phones the click
// arrives as its own event after touchend, not in the same task as pointerup, so the listener
// waits `ms` for it; only the one click is swallowed.
export function swallowNextClick(ms = 500) {
  const swallow = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), ms);
}
