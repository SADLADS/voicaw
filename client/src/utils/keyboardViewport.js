// Phones: keeping the app (and so the message box at its bottom) above the on-screen keyboard.
//
// Android Chrome resizes the page for the keyboard (`interactive-widget=resizes-content` in
// index.html), so there the layout already ends at the keyboard. iOS ignores that and lays the
// keyboard over the page, shrinking only the visual viewport, and slides the page up to show
// the focused box, which the user can then scroll back down behind the keyboard. So while the
// keyboard is open, `--vc-app-height` (the app's height in CSS; 100svh otherwise) is set to the
// visible height, and any slide of the page is undone: the app always ends at the keyboard.
// iOS 26 Safari doesn't always let a slide be undone (the visual viewport stays pushed down,
// `offsetTop` > 0, though the page is scrolled to the top), which left a keyboard-high gap under
// the message box: so the app is also moved down to wherever the visible part starts
// (`--vc-app-top`, the visual viewport's `pageTop`), and lines up with it either way.
//
// The keyboard's height is the visible height's shortfall from the keyboard-free height, the
// tallest seen at this width (a rotation starts over). Not window.innerHeight: with
// resizes-content it shrinks along with the visual viewport.

// Anything shorter than the keyboard-free height by more than this is the keyboard (smaller
// differences are browser toolbars).
export const KEYBOARD_MIN_HEIGHT = 120;

let full = null; // { width, height }: the keyboard-free size at this width

function viewport() {
  return typeof window !== 'undefined' ? window.visualViewport : null;
}

function visibleHeight() {
  return viewport()?.height ?? window.innerHeight;
}

// The keyboard's height now (0 when closed), in CSS px.
export function keyboardInset() {
  const vv = viewport();
  const width = vv?.width ?? window.innerWidth;
  const height = visibleHeight();
  // Pinch zoom also shrinks the visual viewport; that isn't a keyboard.
  if (vv && vv.scale > 1.01) return 0;
  // Never taller than the screen: before the viewport meta applies, Chrome lays the page out
  // 980px wide, and a height seen then would make the keyboard look open for good.
  const tallest = Math.min(Math.max(height, window.innerHeight), window.screen?.height || Infinity);
  if (!full || Math.abs(full.width - width) > 1) full = { width, height: tallest };
  else full.height = Math.max(full.height, tallest);
  return Math.max(0, full.height - height);
}

// The screen's height without the keyboard (as far as seen so far).
export function keyboardFreeHeight() {
  keyboardInset();
  return Math.max(full?.height ?? 0, window.innerHeight);
}

export function keyboardOpen() {
  return keyboardInset() > KEYBOARD_MIN_HEIGHT;
}

// For tests.
export function resetKeyboardViewport() {
  full = null;
}

// Starts keeping the app above the keyboard; returns a function that stops.
export function watchKeyboardViewport() {
  const vv = viewport();
  if (!vv) return () => {};
  const root = document.documentElement;

  const update = () => {
    const open = keyboardOpen();
    if (open) root.style.setProperty('--vc-app-height', `${vv.height}px`);
    else root.style.removeProperty('--vc-app-height');
    // The app is now exactly the visible height, and each pane scrolls inside itself: a
    // slide of the page is the browser's (showing the focused box) or the user's dragging
    // it under the keyboard. Undo it.
    if (open && (window.scrollY !== 0 || vv.offsetTop > 0.5)) window.scrollTo(0, 0);
    // What's left of the slide: the app moves down to meet the visible part (older
    // browsers have no pageTop: offsetTop plus the scroll).
    const top = vv.pageTop ?? (window.scrollY + vv.offsetTop);
    if (open && top > 0.5) root.style.setProperty('--vc-app-top', `${top}px`);
    else root.style.removeProperty('--vc-app-top');
  };

  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  window.addEventListener('scroll', update);
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
    window.removeEventListener('scroll', update);
    root.style.removeProperty('--vc-app-height');
    root.style.removeProperty('--vc-app-top');
  };
}
