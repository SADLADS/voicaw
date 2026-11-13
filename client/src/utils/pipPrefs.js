import { useSyncExternalStore } from 'react';

// Settings → Appearance → Picture in picture, per device (localStorage `pipPrefs`): what a
// video in a message does when it leaves the screen while playing (services/floatingVideo.js).
// `onLeave`: keeps playing in the corner when you go to another chat or page (on by default).
// `onScroll`: also when it's scrolled out of view in its own chat (off by default; only with
// `onLeave` on).
const STORAGE_KEY = 'pipPrefs';
const DEFAULTS = { onLeave: true, onScroll: false };
const listeners = new Set();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs = load();

export function getPipPrefs() {
  return prefs;
}

export function setPipPref(key, value) {
  prefs = { ...prefs, [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered, then.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePipPrefs() {
  return useSyncExternalStore(subscribe, getPipPrefs);
}
