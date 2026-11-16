import { useSyncExternalStore } from 'react';

// Whether Voicaw can be reached right now, while the app is in use (the connection strip,
// ConnectionStrip.jsx; Errors in docs/client.md). Two reports feed it: the websocket's state
// (ws-client.js), and requests that got no answer (api.js). Offline mode, when the app started
// without the server, is utils/offlineMode.js and its own banner.
//
// The socket only counts once it has been online: before that the app is still starting. A
// request getting an answer, or the socket opening, clears a request's report.

let state = { socket: 'offline', wasOnline: false, apiDown: false, nextAttemptAt: null };
const listeners = new Set();

function set(changes) {
  const next = { ...state, ...changes };
  if (Object.keys(next).every((key) => next[key] === state[key])) return;
  state = next;
  listeners.forEach((listener) => listener());
}

// ws-client.js: 'online' | 'connecting' | 'offline', and when it tries again (ms), if it will.
export function noteSocketState(socket, nextAttemptAt = null) {
  if (socket === 'online') set({ socket, wasOnline: true, apiDown: false, nextAttemptAt: null });
  else set({ socket, nextAttemptAt });
}

export const noteRequestUnanswered = () => set({ apiDown: true });
export const noteRequestAnswered = () => set({ apiDown: false });

// Logging out: the next login starts afresh.
export const resetConnection = () => set({ socket: 'offline', wasOnline: false, apiDown: false, nextAttemptAt: null });

// True while Voicaw can't be reached (errors of the 'offline' kind needn't each say so then).
export function connectionTrouble(s = state) {
  return s.apiDown || (s.wasOnline && s.socket !== 'online');
}

export const getConnection = () => state;

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// -> { socket, wasOnline, apiDown, nextAttemptAt }
export function useConnection() {
  return useSyncExternalStore(subscribe, getConnection);
}
