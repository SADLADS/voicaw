// Messages waiting to be forwarded, by chat id (ChatPane's `chatId`): ForwardDialog puts one
// here and opens that chat, whose message box shows it above the text ("Forwarding a message")
// until it's sent or taken back. Only in memory, like drafts (an encrypted chat's text stays
// off the disk): closing or reloading the app forgets it, and logging out clears it.
// Each is { content, at } (utils/forwardMarkup.js forwardSource).
const forwards = new Map();
const listeners = new Set();

export function getForward(chatId) {
  return forwards.get(String(chatId)) ?? null;
}

export function setForward(chatId, forward) {
  if (forward) forwards.set(String(chatId), forward);
  else forwards.delete(String(chatId));
  for (const listener of listeners) listener(String(chatId));
}

export const clearForward = (chatId) => setForward(chatId, null);

// `listener(chatId)` after every change; returns the unsubscribe.
export function onForwardChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearForwards() {
  const chatIds = [...forwards.keys()];
  forwards.clear();
  for (const chatId of chatIds) for (const listener of listeners) listener(chatId);
}
