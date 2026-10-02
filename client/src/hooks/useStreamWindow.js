import { useSyncExternalStore } from 'react';
import { getStreamWindow, onStreamWindowChange } from '../voice/streamWindow';

// Where the popped-out screen share is drawn (voice/streamWindow.js), or null when it isn't.
export function useStreamWindow() {
  return useSyncExternalStore(onStreamWindowChange, getStreamWindow);
}
