import { useEffect } from 'react';
import api from '../utils/api';
import { onConnectionState, onPreferences } from '../utils/ws-client';
import { applyPreferences, resetPreferences } from '../utils/preferences';

// Keeps utils/preferences up to date for the logged-in user (Layout): loaded at login and
// again after a reconnect (changes made elsewhere while offline), and changed by the
// `preferences` event. Back to the defaults on logging out.
export function usePreferencesSync(userId) {
  useEffect(() => {
    if (!userId) return undefined;
    const load = () => api.get('/preferences').then(
      (res) => applyPreferences(res.data),
      (err) => console.warn('Failed to load preferences', err)
    );
    load();
    let wasOnline = true;
    const stopState = onConnectionState((state) => {
      if (state === 'online' && !wasOnline) load();
      wasOnline = state === 'online';
    });
    const stopEvents = onPreferences(applyPreferences);
    return () => {
      stopState();
      stopEvents();
      resetPreferences();
    };
  }, [userId]);
}
