import { keyboardFreeHeight, keyboardInset } from './keyboardViewport';

// The on-screen keyboard's height on this device, so the mobile emoji panel can take exactly
// its place. Measured whenever the keyboard opens (keyboardViewport.js's keyboardInset: the
// visible height's shortfall from the keyboard-free height). Remembered per device.
const KEY = 'keyboardHeight';
const MIN_KEYBOARD = 150;

function fallbackHeight() {
  return Math.round(Math.min(Math.max(keyboardFreeHeight() * 0.4, 260), 380));
}

export function getKeyboardHeight() {
  const saved = Number(localStorage.getItem(KEY));
  // Not innerHeight: on Android it's still short while the keyboard closes for the panel.
  return saved >= MIN_KEYBOARD && saved <= keyboardFreeHeight() * 0.75 ? saved : fallbackHeight();
}

// Starts measuring; returns a function that stops.
export function watchKeyboardHeight() {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const measure = () => {
    const keyboard = Math.round(keyboardInset());
    if (keyboard >= MIN_KEYBOARD) localStorage.setItem(KEY, String(keyboard));
  };
  viewport.addEventListener('resize', measure);
  return () => viewport.removeEventListener('resize', measure);
}
