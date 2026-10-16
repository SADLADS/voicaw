import { useEffect, useRef } from 'react';
import { onCatchUp } from '../utils/catchUp';

// Runs `fetchNewest` (async) whenever the open chat may have missed messages (utils/catchUp.js),
// while `enabled` (its history is loaded from the server). One at a time: a second signal while
// one runs (the app coming back, then its socket reopening) runs it once more after.
export function useCatchUp(fetchNewest, enabled) {
  const fetchRef = useRef(fetchNewest);
  fetchRef.current = fetchNewest;

  useEffect(() => {
    if (!enabled) return undefined;
    let running = false;
    let again = false;
    let stopped = false;
    const run = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        await fetchRef.current();
      } catch (err) {
        // The next signal (the socket reopening) tries again.
        console.warn('Failed to catch up on the chat', err?.message);
      } finally {
        running = false;
        if (again && !stopped) {
          again = false;
          run();
        }
      }
    };
    const stop = onCatchUp(run);
    return () => {
      stopped = true;
      stop();
    };
  }, [enabled]);
}
