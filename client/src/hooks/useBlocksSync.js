import { useEffect } from 'react';
import api from '../utils/api';
import { onBlocks, onConnectionState } from '../utils/ws-client';
import { applyBlocked } from '../utils/blocks';

// Keeps utils/blocks up to date for the logged-in user (Layout): loaded at login and after a
// reconnect, changed by the `blocks` event; emptied on logging out.
export function useBlocksSync(userId) {
  useEffect(() => {
    if (!userId) return undefined;
    const load = () => api.get('/blocks').then(
      (res) => applyBlocked(res.data.blocked, res.data.webhooks),
      (err) => console.warn('Failed to load blocked users', err)
    );
    load();
    let wasOnline = true;
    const stopState = onConnectionState((state) => {
      if (state === 'online' && !wasOnline) load();
      wasOnline = state === 'online';
    });
    const stopEvents = onBlocks(applyBlocked);
    return () => {
      stopState();
      stopEvents();
      applyBlocked([]);
    };
  }, [userId]);
}
