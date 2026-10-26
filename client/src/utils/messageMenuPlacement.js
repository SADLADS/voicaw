// The hover menu (quick reactions, edit, delete...) sits just above its message, over the end
// of the one before, so it never covers the message's own text. Where the message list's top
// edge would cut it off (the first message, or one scrolled half out of view), it goes over the
// message's top right corner instead: never below the message, where it would be looked for in
// the wrong place. Used as the menu's ref callback: placed once as it appears, before paint.
export function placeMessageMenu(menu) {
  if (!menu) return;
  const row = menu.parentElement;
  const scroller = menu.closest('.message-scroller');
  if (!row || !scroller) return;
  const view = scroller.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  if (rowBox.top - menu.offsetHeight >= view.top) return;
  menu.classList.add('inside');
}
