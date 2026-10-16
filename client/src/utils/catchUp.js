import { isEphemeral } from './botComponents';

// Chats load their history once, then follow the websocket. Whatever was sent while the socket
// wasn't listening never arrives that way: a phone asleep in the background (the server's
// heartbeat closes its socket, and the phone only finds out when it wakes), a reconnect, or
// the gap between a chat's first fetch and the socket opening. So the open chat fetches its
// newest page again (hooks/useCatchUp.js) whenever the socket opens (utils/ws-client.js calls
// catchUp) and when the app comes back after being hidden a while (tapping a notification).

// Hidden for less than this, the socket can't have been closed for being silent (the server's
// heartbeat is 30 s), so switching tabs doesn't fetch anything.
const HIDDEN_FOR_MS = 5000;

const listeners = new Set();

export function onCatchUp(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function catchUp() {
  listeners.forEach((cb) => cb());
}

if (typeof document !== 'undefined') {
  let hiddenAt = document.visibilityState === 'visible' ? null : Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      hiddenAt ??= Date.now();
      return;
    }
    const away = hiddenAt != null && Date.now() - hiddenAt >= HIDDEN_FOR_MS;
    hiddenAt = null;
    if (away) catchUp();
  });
}

// A row the server stores (not one being sent, nor a bot's ephemeral reply, kept only here).
const isStored = (m) => Number.isInteger(m.id) && !isEphemeral(m);

// `prev` (a chat's messages, oldest first) brought up to date with `page`, a fresh copy of its
// newest stored rows (oldest first, already made into messages like the rest), at most
// `pageSize` of them. Rows from the page's oldest on are the server's now: new ones added,
// changed ones replaced, missing ones (deleted) dropped; older rows stay. A full page that
// doesn't reach back to anything shown means more was missed than one page: then the list is
// the page alone (`gap`, so older history loads again by scrolling up). Rows only this device
// has (being sent, ephemeral replies) are kept after it; one being sent that the page already
// has (its text from its sender) becomes the stored row, as its websocket echo would.
// -> { messages (prev itself when nothing changed), gap, added (rows that weren't shown) }.
export function mergeNewestPage(prev, page, pageSize) {
  const stored = prev.filter(isStored);
  const newestShown = stored.length ? stored[stored.length - 1].id : null;
  const gap = page.length >= pageSize && newestShown != null && page[0].id > newestShown;
  const cutoff = gap ? -Infinity : (page.length ? page[0].id : Infinity);

  // The rows before the page, as they are (ephemeral ones among them too).
  const firstReplaced = prev.findIndex((m) => isStored(m) && m.id >= cutoff);
  const head = gap ? [] : (firstReplaced === -1 ? prev : prev.slice(0, firstReplaced));
  const tail = gap ? prev : (firstReplaced === -1 ? [] : prev.slice(firstReplaced));

  const before = new Map(prev.filter(isStored).map((m) => [m.id, m]));
  const local = tail.filter((m) => !isStored(m));
  const claimed = new Map();
  const keptLocal = local.filter((m) => {
    if (m.status !== 'pending') return true;
    const match = page.find((row) => !before.has(row.id) && !claimed.has(row.id) &&
      String(row.sender_id) === String(m.sender_id) && row.plaintext === m.plaintext);
    if (!match) return true;
    claimed.set(match.id, m.clientKey ?? m.id);
    return false;
  });

  const added = [];
  const fresh = page.map((row) => {
    const old = before.get(row.id);
    if (!old) {
      const clientKey = claimed.get(row.id);
      added.push(row);
      return clientKey != null ? { ...row, clientKey } : row;
    }
    // The server's fields over this device's own (clientKey...); the same object if none changed.
    const updated = { ...old, ...row };
    return JSON.stringify(old) === JSON.stringify(updated) ? old : updated;
  });

  const messages = [...head, ...fresh, ...keptLocal];
  const unchanged = messages.length === prev.length && messages.every((m, i) => m === prev[i]);
  return { messages: unchanged ? prev : messages, gap, added };
}
