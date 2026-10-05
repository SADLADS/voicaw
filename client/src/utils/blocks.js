import { useSyncExternalStore } from 'react';
import api from './api';

// Who you've blocked (server/blocks.js): their messages are collapsed in guilds and groups
// ("Blocked message · Show"), your DM with them is closed (no messages or calls either way), and
// you aren't notified about them. Loaded at login and kept up to date by the `blocks` event from
// your other devices (hooks/useBlocksSync.js, in Layout).

let blocked = new Set();
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

export function applyBlocked(ids) {
  blocked = new Set((ids ?? []).map(Number));
  notify();
}

export const isBlocked = (userId) => userId != null && blocked.has(Number(userId));

export async function blockUser(userId) {
  applyBlocked((await api.put(`/blocks/${userId}`)).data.blocked);
}

export async function unblockUser(userId) {
  applyBlocked((await api.delete(`/blocks/${userId}`)).data.blocked);
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => blocked;

// The blocked ids (a Set), redrawing when it changes.
export function useBlocked() {
  return useSyncExternalStore(subscribe, snapshot);
}
