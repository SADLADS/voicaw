// Chromium's VirtualKeyboard API (Chrome, Brave, Edge on Android). With `overlaysContent` on,
// the keyboard is laid over the page instead of resizing it, and its exact rectangle is
// reported. We only turn that on during mobile emoji search: the visual viewport's height is
// unreliable there (with the address bar at the bottom it comes out one toolbar too short).
// Read lazily so tests can install a fake.

function api() {
  return typeof navigator !== 'undefined' ? navigator.virtualKeyboard : undefined;
}

export function hasVirtualKeyboardApi() {
  return Boolean(api());
}

export function setKeyboardOverlaysContent(on) {
  const vk = api();
  if (vk) vk.overlaysContent = on;
}

// Calls `onChange(rect)` with the keyboard's rectangle (zero height when hidden), now and on
// every change. Returns an unsubscribe function.
export function watchKeyboardRect(onChange) {
  const vk = api();
  if (!vk) return () => {};
  const report = () => onChange(vk.boundingRect);
  vk.addEventListener('geometrychange', report);
  report();
  return () => vk.removeEventListener('geometrychange', report);
}
