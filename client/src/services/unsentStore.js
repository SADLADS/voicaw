// Messages that couldn't be sent, by chat id (ChatPane's `chatId`): they stay at the end of
// their chat with Retry and Delete, also after going elsewhere in the app and back (see
// useUnsentMessages). Only in memory, like drafts (draftStore.js): encrypted chats' text stays
// off the disk, and closing the tab, window or app (or logging out) forgets them.
const EMPTY = [];
const unsent = new Map();
const listeners = new Set();

function changed() {
  listeners.forEach((listener) => listener());
}

// The chat's unsent messages, oldest first (the same array until they change).
export function getUnsent(chatId) {
  return unsent.get(String(chatId)) ?? EMPTY;
}

export function addUnsent(chatId, entry) {
  const key = String(chatId);
  unsent.set(key, [...getUnsent(key).filter((e) => e.id !== entry.id), entry].sort((a, b) => a.order - b.order));
  changed();
}

export function removeUnsent(chatId, id) {
  const key = String(chatId);
  const kept = getUnsent(key).filter((e) => e.id !== id);
  if (kept.length === getUnsent(key).length) return false;
  if (kept.length) unsent.set(key, kept);
  else unsent.delete(key);
  changed();
  return true;
}

export function subscribeUnsent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearUnsent() {
  unsent.clear();
  changed();
}
