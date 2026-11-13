import { useLayoutEffect, useSyncExternalStore } from 'react';

// The corner (Layout's .corner-players) shows one small player at a time: a watched stream or
// focused camera (StreamCorner), Watch Together's mini player, or a video from a message
// (VideoCorner). First come, first served: whoever wanted it first keeps it until it no longer
// does, then the next still waiting gets it. Those waiting carry on unseen: a stream and Watch
// Together keep their sound; a video never waits (it stops instead, services/floatingVideo.js).
// Popped-out windows aren't the corner and don't count.
let queue = []; // kinds wanting the corner, the holder first
const listeners = new Set();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function cornerHolder() {
  return queue[0] ?? null;
}

// Whether `kind` could take the corner now (it's free, or already its own).
export function cornerFreeFor(kind) {
  return queue.length === 0 || queue[0] === kind;
}

export function wantCorner(kind) {
  if (queue.includes(kind)) return;
  queue = [...queue, kind];
  notify();
}

export function leaveCorner(kind) {
  if (!queue.includes(kind)) return;
  queue = queue.filter((each) => each !== kind);
  notify();
}

export function useCornerHolder() {
  return useSyncExternalStore(subscribe, cornerHolder);
}

// For a player that wants the corner while `wants`: whether it has it. Asked before paint, so
// it never shows for a frame over another.
export function useCornerClaim(kind, wants) {
  useLayoutEffect(() => {
    if (!wants) return undefined;
    wantCorner(kind);
    return () => leaveCorner(kind);
  }, [kind, wants]);
  const holder = useCornerHolder();
  return wants && (holder === kind || (holder == null && cornerFreeFor(kind)));
}

// Tests only.
export function resetCornerSlot() {
  queue = [];
  notify();
}
