// The browser's own right-click menu is off across the app (our menus replace it where there
// is something to do: channels, guilds, conversations...), except where it's still the useful
// one: text boxes (spellcheck suggestions, paste), selected text (copy), and links inside
// messages and embeds (copy link, open in a new tab). Pictures have our own menu (ImageMenu).

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const IN_MESSAGE = '.dm-message-content a[href], .message-embeds a[href], .message-files a[href]';

// Whether a right-click on `target` should get the browser's menu, with `selectedText` selected.
export function allowsNativeMenu(target, selectedText = '') {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  if (!element) return false;
  if (element.closest(EDITABLE)) return true;
  if (selectedText.trim()) return true;
  return Boolean(element.closest(IN_MESSAGE));
}

// Turns it off (once, for the page). A menu of ours that already handled the event (it called
// preventDefault) is left alone.
export function blockNativeContextMenu(doc = document) {
  doc.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const selected = doc.getSelection?.()?.toString() ?? '';
    if (!allowsNativeMenu(e.target, selected)) e.preventDefault();
  });
}
