import { useSyncExternalStore } from 'react';

// Light or dark, per device (localStorage `theme`: 'light', 'system', or nothing for dark, the
// default). Never sent to the server, so each browser (and the desktop app) keeps its own.
// 'system' follows the system's setting live (prefers-color-scheme).
//
// It's put on <html> as data-theme (our colours, voicaw.css), data-bs-theme (Bootstrap's) and
// through those the CSS color-scheme, which is what makes the browser's own parts match: form
// controls and scrollbars. Not the on-screen keyboard: on iPhones and iPads it follows the
// system's light/dark mode (WebKit gives every field UIKeyboardAppearanceDefault and never
// looks at the page), and Android keyboards follow the system or their own setting. Only a
// native app can choose on iOS (UITextInputTraits.keyboardAppearance; in a Capacitor wrapper,
// @capacitor/keyboard's setStyle); on Android not even that.
//
// index.html has a copy of `resolve` that runs before the CSS, so a light page never starts dark.

export const THEMES = ['dark', 'light', 'system'];
const STORAGE_KEY = 'theme';
const listeners = new Set();

function load() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(value) ? value : 'dark';
  } catch {
    return 'dark';
  }
}

let choice = load();

const systemQuery = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;

// 'light' or 'dark': what the page actually shows.
export function resolveTheme(value = choice) {
  if (value === 'system') return systemQuery?.matches ? 'light' : 'dark';
  return value === 'light' ? 'light' : 'dark';
}

export function getThemeChoice() {
  return choice;
}

// Puts the theme on the page (at startup, on every change, and when the system's changes).
export function applyTheme() {
  if (typeof document === 'undefined') return;
  const theme = resolveTheme();
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.bsTheme = theme;
}

export function setThemeChoice(value) {
  choice = THEMES.includes(value) ? value : 'dark';
  try {
    if (choice === 'dark') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Not remembered, then.
  }
  applyTheme();
  listeners.forEach((listener) => listener());
}

systemQuery?.addEventListener?.('change', () => {
  if (choice !== 'system') return;
  applyTheme();
  listeners.forEach((listener) => listener());
});

// Another tab of the app changed it: follow (that tab's choice is this device's too).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    choice = load();
    applyTheme();
    listeners.forEach((listener) => listener());
  });
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// { choice: 'dark' | 'light' | 'system', theme: 'dark' | 'light' }
let snapshot = { choice, theme: resolveTheme() };
function getSnapshot() {
  const theme = resolveTheme();
  if (snapshot.choice !== choice || snapshot.theme !== theme) snapshot = { choice, theme };
  return snapshot;
}

export function useTheme() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
