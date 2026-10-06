import { useSyncExternalStore } from 'react';
import { t } from '../i18n';

// Tracks whether a newer version of the app is ready, and applies it. main.jsx wires this to
// the service worker (vite-plugin-pwa's registerSW, in "prompt" mode): a new deploy installs a
// new service worker, which precaches the new build and then waits; `applyUpdate()` tells it
// to take over (dropping the old build's cache) and reloads the page onto the new version.
//
// Browsers only look for a new service worker on navigation, which a long-open tab or the
// Home Screen app rarely does, so `watchForUpdates` also checks periodically and whenever the
// app comes back into view, and keeps doing so once one is waiting (a newer deploy replaces
// it). Updating looks once more first (briefly), so it switches to the latest version, not the
// first one it noticed.
//
// The desktop and Android apps update themselves instead (`watchDesktopUpdates`,
// `watchAndroidUpdates`).

const CHECK_EVERY_MS = 30 * 60 * 1000;
const MIN_CHECK_GAP_MS = 60 * 1000;
// If the new service worker hasn't reloaded the page by then, reload anyway.
const RELOAD_FALLBACK_MS = 4000;
const ANDROID_CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const ANDROID_MIN_CHECK_GAP_MS = 30 * 60 * 1000;
// How long updating waits for its last look before applying what it has.
const LAST_LOOK_MS = 5000;

// available: an update is ready to apply; seq: counts them (UpdateBanner's dismissing);
// reloads: applying it reloads the page (false for the desktop and Android apps, which install
// a new app); version: the desktop or Android update's; size: the Android one's; lastLook:
// updating is looking for a newer version first; progress: the desktop or Android download
// (0 to 1, null when not updating); failed: it couldn't be downloaded; androidVersion: the
// installed Android app's.
let state = { available: false, seq: 0, reloads: true, version: null, size: null, lastLook: false, progress: null, failed: false, androidVersion: null };
const listeners = new Set();
let apply = null;
let registration = null;
let desktopApp = null;
let androidApp = null;
let lastCheck = 0;

function setState(next) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Called when an update is ready. `applyFn` switches to it (and should reload the page,
// unless `reloads` is false). Each new update bumps `seq`, so a dismissed banner shows again
// for the next one; the desktop or Android app finding the same version again changes nothing.
export function setUpdateAvailable(applyFn, { reloads = true, version = null, size = null } = {}) {
  apply = applyFn;
  if (state.available && version !== null && state.version === version && state.size === size) return;
  // A newer one turning up while updating (the desktop app's last look) keeps its progress.
  const updating = state.lastLook || state.progress != null;
  setState({ available: true, seq: state.seq + 1, reloads, version, size, ...(updating ? {} : { progress: null, failed: false }) });
}

export async function applyUpdate() {
  if (!state.reloads) return apply?.();
  if (state.lastLook) return;
  // A newer deploy since this one was found: let it install, so it's the one waiting.
  if (registration) {
    setState({ lastLook: true });
    await withinLastLook(updateRegistration().catch(() => {}));
    setState({ lastLook: false });
  }
  setTimeout(() => window.location.reload(), RELOAD_FALLBACK_MS);
  try {
    await apply?.();
  } finally {
    if (!apply) window.location.reload();
  }
}

// Asks the browser to look for a new version now. Resolves to 'available', 'current',
// 'downloading' (the desktop app, getting one) or 'unsupported' (no service worker, e.g. an old
// browser, a desktop app that can't update itself, or the Android app from Google Play).
export async function checkForUpdates() {
  if (androidApp) return checkAndroid();
  // The desktop app: it may also say 'downloading' (it gets the whole app, then offers it).
  if (desktopApp) return desktopApp.checkForUpdates();
  if (!registration) return 'unsupported';
  await updateRegistration();
  return state.available || registration.waiting ? 'available' : 'current';
}

function withinLastLook(promise) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, LAST_LOOK_MS))]);
}

// Asks the browser to look for a new service worker, and waits for one it finds to install.
async function updateRegistration() {
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
}

function checkQuietly() {
  if (Date.now() - lastCheck < MIN_CHECK_GAP_MS || state.lastLook) return;
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
// "Update now" restarts onto the newest (it looks once more first, and may download a newer
// one, showing its progress).
export function watchDesktopUpdates(app) {
  desktopApp = app;
  app.onUpdateReady((version) => setUpdateAvailable(installDesktopUpdate, { reloads: false, version }));
  app.onUpdateProgress?.((fraction) => {
    if (state.lastLook || state.progress != null) setState({ lastLook: false, progress: Math.min(fraction, 0.99) });
  });
}

async function installDesktopUpdate() {
  if (state.lastLook || state.progress != null) return;
  setState({ lastLook: true, failed: false });
  let installed = false;
  try {
    installed = await desktopApp.installUpdate(); // the app restarts
  } catch (err) {
    console.warn('Update failed', err);
  }
  if (!installed) setState({ lastLook: false, progress: null, failed: true });
}

// The Android app from updates.voicaw.com (mobile/.../AppUpdater.java) asks there now and then;
// a new version is only downloaded on "Update" (it's tens of MB, maybe over mobile data), then
// handed to Android, which asks to install it and replaces the app. Google Play's build says
// it's unsupported: Play updates it.
async function checkAndroid() {
  lastCheck = Date.now();
  const info = await androidApp.checkForUpdate();
  if (info.current && info.current !== state.androidVersion) setState({ androidVersion: info.current });
  if (!info.supported) return 'unsupported';
  if (!info.available) return 'current';
  // AppUpdater downloads whatever is newest on "Update", so a check while it does changes nothing.
  if (state.progress != null) return 'available';
  setUpdateAvailable(installAndroidUpdate, { reloads: false, version: info.version, size: info.size });
  return 'available';
}

async function installAndroidUpdate() {
  if (state.progress != null) return;
  setState({ progress: 0, failed: false });
  try {
    await androidApp.installUpdate();
    setState({ progress: 1 }); // Android is asking to install it
  } catch (err) {
    console.warn('Update failed', err);
    setState({ progress: null, failed: true });
  }
}

// What the desktop or Android update is doing, for UpdateBanner and Settings: null when it
// isn't and nothing went wrong.
export function updateProgressText({ lastLook, progress, failed }) {
  if (lastLook) return t('settings.appVersion.lastLook');
  if (progress != null) {
    return progress >= 1
      ? t('settings.appVersion.installing')
      : t('settings.appVersion.downloadingPercent', { percent: Math.floor(progress * 100) });
  }
  return failed ? t('settings.appVersion.downloadFailed') : null;
}

export function watchAndroidUpdates(app) {
  androidApp = app;
  app.addListener('updateProgress', ({ received, total }) => {
    if (state.progress != null) setState({ progress: total ? Math.min(received / total, 0.99) : 0 });
  });
  // Cancelled at Android's question, or Android couldn't install it: "Update" again.
  app.addListener('updateResult', ({ status }) => setState({ progress: null, failed: status !== 'aborted' }));
  const quietly = () => {
    if (Date.now() - lastCheck < ANDROID_MIN_CHECK_GAP_MS) return;
    checkAndroid().catch(() => {}); // offline etc.: try again later
  };
  checkAndroid().catch(() => {});
  setInterval(quietly, ANDROID_CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') quietly();
  });
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
