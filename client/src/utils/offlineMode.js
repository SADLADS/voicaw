import { useSyncExternalStore } from 'react';

// Offline mode (Offline copy, docs/messages.md): the app started without reaching the server,
// and shows what services/offlineCopy.js saved, read-only. `reachable` turns true once the
// server answers again (OfflineBanner then offers to reconnect, which reloads the app).

let state = { offline: false, reachable: false };
const listeners = new Set();

function set(changes) {
  state = { ...state, ...changes };
  listeners.forEach((listener) => listener());
}

export const isOfflineMode = () => state.offline;
export const setOfflineMode = (offline) => set({ offline, reachable: false });
export const setReachable = () => set({ reachable: true });

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// -> { offline, reachable }
export function useOfflineMode() {
  return useSyncExternalStore(subscribe, () => state);
}

// A request that failed for want of the server (no answer, or the proxy saying the API is
// down or restarting), not because the server refused it.
export function isUnreachable(err) {
  if (err?.code === 'ERR_CANCELED' || err?.name === 'AbortError') return false;
  const status = err?.response?.status;
  return !err?.response || status === 502 || status === 503 || status === 504;
}
