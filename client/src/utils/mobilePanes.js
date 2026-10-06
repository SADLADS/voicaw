// Phone layout: which of the two panes is showing, the list (rail + conversations or channels)
// or the content (the chat). Layout's useSwipePanes owns the state; anything that opens a chat
// from elsewhere (a list row, an answered call, a notification) calls showContent().
const listeners = new Set();

// A showContent() nobody heard: the panes are off (Settings, the developer portal...) and the
// navigation made with it turns them on. useSwipePanes takes it when they do, so a chat opened
// from a notification over Settings shows the chat, not the list. Only for a moment: one the
// navigation didn't follow is stale.
const PENDING_MS = 1000;
let pendingContentAt = 0;

export function showContent() {
  if (listeners.size === 0) pendingContentAt = Date.now();
  for (const listener of listeners) listener('content');
}

export function showList() {
  pendingContentAt = 0;
  for (const listener of listeners) listener('list');
}

export function onPaneRequest(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Whether a showContent() was waiting for the panes (and forgets it).
export function takePendingContent() {
  const pending = Date.now() - pendingContentAt < PENDING_MS;
  pendingContentAt = 0;
  return pending;
}
