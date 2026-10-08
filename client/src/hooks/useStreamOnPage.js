import { useEffect, useSyncExternalStore } from 'react';

// Whether a page (a voice channel's, a call panel) is showing the watched stream. While none
// is, StreamCorner shows it small in a corner, so it carries on wherever you go.
let onPage = 0;
const listeners = new Set();

function changeBy(delta) {
  onPage += delta;
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStreamOnPage() {
  return useSyncExternalStore(subscribe, () => onPage > 0);
}

// Called by a StreamView drawn on a page (not the corner's, nor a popped-out one).
export function useShowsStreamOnPage(active) {
  useEffect(() => {
    if (!active) return undefined;
    changeBy(1);
    return () => changeBy(-1);
  }, [active]);
}
