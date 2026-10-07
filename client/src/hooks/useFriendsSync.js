import { useEffect } from 'react';
import { onConnectionState, onFriends } from '../utils/ws-client';
import { applyFriends, loadFriends } from '../utils/friends';

// Keeps utils/friends up to date for the logged-in user (Layout): loaded at login and after a
// reconnect, changed by the `friends` event; emptied on logging out.
export function useFriendsSync(userId) {
  useEffect(() => {
    if (!userId) return undefined;
    const load = () => loadFriends().catch((err) => console.warn('Failed to load friends', err));
    load();
    let wasOnline = true;
    const stopState = onConnectionState((state) => {
      if (state === 'online' && !wasOnline) load();
      wasOnline = state === 'online';
    });
    const stopEvents = onFriends(applyFriends);
    return () => {
      stopState();
      stopEvents();
      applyFriends(null);
    };
  }, [userId]);
}
