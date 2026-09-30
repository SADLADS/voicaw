// Phone layout: which of the two panes is showing, the list (rail + conversations or channels)
// or the content (the chat). Layout's useSwipePanes owns the state; anything that opens a chat
// from elsewhere (a list row, an answered call, a notification) calls showContent().
const listeners = new Set();

export function showContent() {
  for (const listener of listeners) listener('content');
}

export function showList() {
  for (const listener of listeners) listener('list');
}

export function onPaneRequest(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
