import { useSyncExternalStore } from 'react';

// Spellcheck while typing (red underlines, suggestions on right click), on or off per device
// (localStorage `spellcheck`: 'off' turns it off; on by default). The browser, or the desktop
// app, does the checking with its own dictionaries, and "Add to dictionary" goes into those, so
// it stays on the device. It's set on <html>: every text box without its own `spellcheck`
// inherits it.

const STORAGE_KEY = 'spellcheck';
const listeners = new Set();

function load() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

let enabled = load();

export function isSpellcheckEnabled() {
  return enabled;
}

// Puts the choice on the page (at startup and on every change).
export function applySpellcheck() {
  if (typeof document !== 'undefined') document.documentElement.spellcheck = enabled;
}

export function setSpellcheckEnabled(value) {
  enabled = Boolean(value);
  try {
    if (enabled) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, 'off');
  } catch {
    // Not remembered, then.
  }
  applySpellcheck();
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSpellcheck() {
  return useSyncExternalStore(subscribe, isSpellcheckEnabled);
}
