import { useSyncExternalStore } from 'react';

// Tracks whether a newer version of the app is ready, and applies it. main.jsx wires this to
// the service worker (vite-plugin-pwa's registerSW, in "prompt" mode): a new deploy installs a
// new service worker, which precaches the new build and then waits; `applyUpdate()` tells it
// to take over (dropping the old build's cache) and reloads the page onto the new version.
//
// Browsers only look for a new service worker on navigation, which a long-open tab or the
// Home Screen app rarely does, so `watchForUpdates` also checks periodically and whenever the
// app comes back into view.

const CHECK_EVERY_MS = 30 * 60 * 1000;
const MIN_CHECK_GAP_MS = 60 * 1000;
// If the new service worker hasn't reloaded the page by then, reload anyway.
const RELOAD_FALLBACK_MS = 4000;

let state = { available: false, seq: 0 };
const listeners = new Set();
let apply = null;
let registration = null;
let desktopApp = null;
let lastCheck = 0;

function setState(next) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Called when an update is ready. `applyFn` switches to it (and should reload the page).
// Each new detection bumps `seq`, so a dismissed banner shows again for the next update.
export function setUpdateAvailable(applyFn) {
  apply = applyFn;
  setState({ available: true, seq: state.seq + 1 });
}

export async function applyUpdate() {
  setTimeout(() => window.location.reload(), RELOAD_FALLBACK_MS);
  try {
    await apply?.();
  } finally {
    if (!apply) window.location.reload();
  }
}

// Asks the browser to look for a new version now. Resolves to 'available', 'current',
// 'downloading' (the desktop app, getting one) or 'unsupported' (no service worker, e.g. an old
// browser, or a desktop app that can't update itself).
export async function checkForUpdates() {
  if (state.available) return 'available';
  // The desktop app: it may also say 'downloading' (it gets the whole app, then offers it).
  if (desktopApp) return desktopApp.checkForUpdates();
  if (!registration) return 'unsupported';
  lastCheck = Date.now();
  await registration.update();
  const incoming = registration.installing;
  if (incoming) {
    await new Promise((resolve) => {
      const done = () => {
        if (incoming.state !== 'installing') {
          incoming.removeEventListener('statechange', done);
          resolve();
        }
      };
      incoming.addEventListener('statechange', done);
      done();
    });
  }
  return state.available || registration.waiting ? 'available' : 'current';
}

function checkQuietly() {
  if (Date.now() - lastCheck < MIN_CHECK_GAP_MS || state.available) return;
  checkForUpdates().catch(() => {}); // offline etc.: try again later
}

// Starts the periodic and on-return checks for this service worker registration.
export function watchForUpdates(reg) {
  registration = reg;
  lastCheck = Date.now(); // it was just registered, which checks
  setInterval(checkQuietly, CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkQuietly();
  });
  window.addEventListener('online', checkQuietly);
}

// The desktop app updates itself (electron/updater.js): once it has downloaded a new version,
// "Update now" restarts onto it.
export function watchDesktopUpdates(app) {
  desktopApp = app;
  app.onUpdateReady(() => setUpdateAvailable(() => app.installUpdate()));
}

// Another tab applied an update (this one is now controlled by the new version's service
// worker), or a lazily loaded part of the app from the old build is gone from the server:
// either way this page needs a reload to be consistent again.
export function watchForStaleApp() {
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!state.available) setUpdateAvailable(() => window.location.reload());
    });
  }
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    setUpdateAvailable(() => window.location.reload());
  });
}

export function useAppUpdate() {
  return useSyncExternalStore(subscribe, () => state);
}
