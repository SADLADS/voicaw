import { useSyncExternalStore } from 'react';
import { cornerFreeFor, leaveCorner, wantCorner } from './cornerSlot';
import { onPlaybackClaimed } from '../utils/videoPlayer';

// A video from a message playing on outside its message (components/VideoPlayer.jsx): small in
// the corner (VideoCorner) once you left its chat or page while it played (or scrolled it out
// of view, Settings → Appearance → Picture in picture), or in a window of its own (Pop out,
// VideoPopout). The <video> element itself moves, never a copy: moved within the page in one
// go, a playing video doesn't even pause (it would if left out of the page past the current
// task), so nothing is downloaded or decrypted again. Coming back to the message hands it back.
//
// One at a time, like playing (utils/videoPlayer.js claimPlayback): starting another video
// closes this one. It only takes the corner while that's free (services/cornerSlot.js): a
// stream or Watch Together already there keeps it, and the video stops as before.
//
// An entry: { key, element, src, name, poster, width, height, origin: { path, messageId,
// chatName }, release(), mode: 'corner' | 'window' }. `release` frees what the player held for
// it (a streaming URL, a pinned decrypted copy) once it's closed.
let current = null;
const listeners = new Set();
// Players drawn on a page, by key, that can take their video back: key -> take(entry).
const players = new Map();
let parking = null;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFloatingVideo() {
  return current;
}

export function useFloatingVideo() {
  return useSyncExternalStore(subscribe, getFloatingVideo);
}

// Where a handed-off video waits (in the page, playing) until the corner or the window takes it:
// moving it there in the same task as its player going keeps it playing.
export function parkingSpot() {
  if (!parking || !parking.isConnected) {
    parking = document.createElement('div');
    parking.className = 'floating-video-parking';
    parking.setAttribute('aria-hidden', 'true');
    document.body.appendChild(parking);
  }
  return parking;
}

// Moves a video into `parent`. Within the page it plays on untouched. Into or out of another
// window's document (a window whose picture couldn't be copied: another site's video) the
// browser loads it afresh, so it carries on from the same point.
export function moveVideo(element, parent) {
  if (element.parentNode === parent) return;
  if (element.ownerDocument === parent.ownerDocument) {
    parent.appendChild(element);
    return;
  }
  const at = element.currentTime;
  const wasPlaying = !element.paused && !element.ended;
  parent.appendChild(element);
  element.addEventListener('loadedmetadata', () => {
    element.currentTime = at;
    if (wasPlaying) Promise.resolve(element.play()).catch(() => {});
  }, { once: true });
}

export function park(element) {
  moveVideo(element, parkingSpot());
}

function setCurrent(next) {
  if (current?.mode === 'corner' && next?.mode !== 'corner') leaveCorner('video');
  if (next?.mode === 'corner') wantCorner('video');
  current = next;
  notify();
}

// A player letting its playing video go on: to the corner (refused, false, while a stream or
// Watch Together has it) or a window. Must be called while the element is still in the page,
// and moves it into the page's parking spot at once.
export function floatVideo(entry, mode = 'corner') {
  if (mode === 'corner' && !cornerFreeFor('video')) return false;
  if (current && current.key !== entry.key) closeFloatingVideo();
  park(entry.element);
  setCurrent({ ...entry, mode });
  return true;
}

// Moves the floating video between the corner and a window. False: the corner is taken.
export function setFloatingMode(mode) {
  if (!current || current.mode === mode) return true;
  if (mode === 'corner' && !cornerFreeFor('video')) return false;
  setCurrent({ ...current, mode });
  return true;
}

// A player on a page for `key`: `take(entry)` gets the video back when it's brought back.
export function registerVideoPlayer(key, take) {
  players.set(key, take);
  return () => {
    if (players.get(key) === take) players.delete(key);
  };
}

export function hasVideoPlayer(key) {
  return players.has(key);
}

// The player for `key` takes its video back (it's showing again): the entry, or null when it
// isn't this one's. The player moves the element into itself in the same task.
export function reclaimVideo(key) {
  if (!current || current.key !== key) return null;
  const entry = current;
  setCurrent(null);
  return entry;
}

// Bring back (the window's note or the window closing): to its message's player if one is on
// the page, else to the corner if free; else it stops.
export function bringBackVideo() {
  if (!current) return;
  const take = players.get(current.key);
  if (take) {
    const entry = current;
    setCurrent(null);
    take(entry);
    return;
  }
  if (!setFloatingMode('corner')) closeFloatingVideo();
}

// Close: stops it and frees what it held.
export function closeFloatingVideo() {
  const entry = current;
  if (!entry) return;
  setCurrent(null);
  entry.element.pause();
  if (entry.element.parentNode === parking) entry.element.remove();
  try {
    entry.release?.();
  } catch (err) {
    console.error('Failed to release a video', err);
  }
}

// Another video starting replaces this one.
onPlaybackClaimed((video) => {
  if (current && current.element !== video) closeFloatingVideo();
});

// Logging out or the page going: nothing to keep.
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => closeFloatingVideo());

// Tests only.
export function resetFloatingVideo() {
  current = null;
  players.clear();
  leaveCorner('video');
  notify();
}
