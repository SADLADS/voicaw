import { useSyncExternalStore } from 'react';
import { getCallSnapshot, onCallChange } from '../voice/callClient';

// This device's call (voice/callClient.js): null or { id, groupId, peerId, peerName,
// callerName, outgoing, state: 'ringing' | 'connecting' | 'active', answeredAt, participants }.
export function useCall() {
  return useSyncExternalStore(onCallChange, getCallSnapshot).call;
}

// The call going on in a group (the server's shape), or null.
export function useGroupCall(groupId) {
  return useSyncExternalStore(onCallChange, getCallSnapshot).groupCalls[groupId] ?? null;
}
