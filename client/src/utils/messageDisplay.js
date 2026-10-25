import { useSyncExternalStore } from 'react';

// How messages are laid out, per device like the theme (localStorage `messageDisplay`): 'cozy',
// the default (pictures, the name and time above the text), or 'compact' (as Discord's: no
// pictures, the time, the name and the text on one line). Put on <html> as
// data-message-display for the CSS (dms.css, COMPACT MESSAGES); MessageList reads it to give
// follow-up lines their name.

export const MESSAGE_DISPLAYS = ['cozy', 'compact'];
const STORAGE_KEY = 'messageDisplay';
const listeners = new Set();

function load() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return MESSAGE_DISPLAYS.includes(value) ? value : 'cozy';
  } catch {
    return 'cozy';
  }
}

let display = load();

export function getMessageDisplay() {
  return display;
}

// Puts it on the page (at startup and on every change).
export function applyMessageDisplay() {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.messageDisplay = display;
}

export function setMessageDisplay(value) {
  display = MESSAGE_DISPLAYS.includes(value) ? value : 'cozy';
  try {
    if (display === 'cozy') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, display);
  } catch {
    // Not remembered, then.
  }
  applyMessageDisplay();
  listeners.forEach((listener) => listener());
}

// Another tab of the app changed it: follow.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    display = load();
    applyMessageDisplay();
    listeners.forEach((listener) => listener());
  });
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMessageDisplay() {
  return useSyncExternalStore(subscribe, getMessageDisplay, getMessageDisplay);
}
