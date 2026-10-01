// The on-screen keyboard's height on this device, so the mobile emoji panel can take exactly
// its place. Measured whenever the keyboard opens: it shrinks the visual viewport (iOS, and
// Android Chrome's default) while window.innerHeight stays the same. Remembered per device.

const KEY = 'keyboardHeight';
const MIN_KEYBOARD = 150;

function fallbackHeight() {
  return Math.round(Math.min(Math.max(window.innerHeight * 0.4, 260), 380));
}

export function getKeyboardHeight() {
  const saved = Number(localStorage.getItem(KEY));
  return saved >= MIN_KEYBOARD && saved <= window.innerHeight * 0.75 ? saved : fallbackHeight();
}

// Starts measuring; returns a function that stops.
export function watchKeyboardHeight() {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const measure = () => {
    const keyboard = Math.round(window.innerHeight - viewport.height);
    if (keyboard >= MIN_KEYBOARD) localStorage.setItem(KEY, String(keyboard));
  };
  viewport.addEventListener('resize', measure);
  return () => viewport.removeEventListener('resize', measure);
}
