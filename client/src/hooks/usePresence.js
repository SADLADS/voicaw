import { useSyncExternalStore } from 'react';
import { getPresenceVersion, presenceOf, subscribePresence } from '../utils/presence';

// Re-renders when anyone's online status changes; returns `presenceOf` (utils/presence.js).
export function usePresence() {
  useSyncExternalStore(subscribePresence, getPresenceVersion);
  return presenceOf;
}
