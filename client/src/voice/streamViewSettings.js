import { useSyncExternalStore } from 'react';

// Which copy of others' screen shares this device downloads (the viewer's Stream quality, in
// the stream bar; localStorage `streamViewQuality`). Every stream comes in two copies (LiveKit's
// simulcast, see streamSettings.js): full size, and half the width and height at the same frame
// rate and a quarter of the bitrate.
// - 'auto': the full-size copy, LiveKit's server moving to the small one on its own while the
//   connection can't keep up (what everyone got before there was a choice);
// - 'low': always the small copy (data saver: phones on mobile data, slow connections).
// One choice for every stream, remembered on this device.

const KEY = 'streamViewQuality';

export const VIEW_QUALITIES = ['auto', 'low'];
export const DEFAULT_VIEW_QUALITY = 'auto';

export const cleanViewQuality = (raw) => (VIEW_QUALITIES.includes(raw) ? raw : DEFAULT_VIEW_QUALITY);

function load() {
  try {
    return cleanViewQuality(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_VIEW_QUALITY;
  }
}

let quality = load();
const listeners = new Set();

export const getStreamViewQuality = () => quality;

export function onStreamViewQualityChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useStreamViewQuality = () => useSyncExternalStore(onStreamViewQualityChange, getStreamViewQuality);

export function setStreamViewQuality(value) {
  const next = cleanViewQuality(value);
  if (next === quality) return;
  quality = next;
  try {
    localStorage.setItem(KEY, quality);
  } catch {
    // Not remembered, then.
  }
  for (const listener of listeners) listener(quality);
}
