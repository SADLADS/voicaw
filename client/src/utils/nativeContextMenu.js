// The browser's own right-click menu is off across the app: ours replace it everywhere (text
// boxes, selected text, links and pictures: PageMenus; channels, guilds, conversations,
// messages...: their own). Two exceptions keep it: Shift+right-click (the way to the
// browser's own when wanted, e.g. its spelling suggestions in a language we have no
// dictionary for), and text boxes on a phone, whose own selection handles and paste bar stay.

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

// Whether a right-click on `target` should get the browser's menu.
export function allowsNativeMenu(target, { shiftKey = false, phone = false } = {}) {
  if (shiftKey) return true;
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  if (!element) return false;
  return phone && Boolean(element.closest(EDITABLE));
}

// Turns it off (once, for the page). Listening on the window, it runs after every other
// listener: a menu of ours that already handled the event (it called preventDefault) is left
// alone.
export function blockNativeContextMenu(win = window) {
  win.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const phone = win.document.body.classList.contains('mobile-mode');
    if (!allowsNativeMenu(e.target, { shiftKey: e.shiftKey, phone })) e.preventDefault();
  });
}
