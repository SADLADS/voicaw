import { useSyncExternalStore } from 'react';
import { getCallSnapshot, onCallChange } from '../voice/callClient';

// This device's DM call (voice/callClient.js): null or { id, peerId, peerName, outgoing,
// state: 'ringing' | 'connecting' | 'active', answeredAt }.
export function useCall() {
  return useSyncExternalStore(onCallChange, getCallSnapshot).call;
}
