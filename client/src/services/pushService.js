import api from '../utils/api';
import { isDesktopApp } from '../utils/desktop';
import { androidNotificationState, androidSubscription, isAndroidApp, requestAndroidNotifications } from '../utils/android';
import { refreshPresence } from '../utils/ws-client';
import { t } from '../i18n';

// Web push for this device: permission, the browser's push subscription, and keeping the
// server's copy of it current. Notifications themselves are shown by service-worker.js.
//
// The desktop app has no web push: the server sends it the same notifications over the
// websocket while it runs (utils/desktopNotifications.js), so there it's only on or off.
// The Android app has no web push either: it registers its Firebase token instead (the same
// subscription list, endpoint `fcm:<token>`), and asks Android for the permission.

// Set when the user turns notifications off on this device, so opening the app doesn't
// quietly subscribe again just because the browser permission is still granted.
const DISABLED_KEY = 'pushDisabled';

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS
}

export function isInstalledApp() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// One of:
//   'needs-install' - iOS/iPadOS in the browser: web push only works from the Home Screen app
//   'unsupported'   - this browser can't do web push
//   'denied'        - the user blocked notifications (only fixable in browser settings)
//   'off'           - allowed, but turned off on this device in Voicaw
//   'can-enable'    - not asked yet
//   'granted'       - allowed
export function getPushStatus() {
  if (isDesktopApp()) return localStorage.getItem(DISABLED_KEY) === '1' ? 'off' : 'granted';
  if (isAndroidApp()) {
    const { permission, push } = androidNotificationState();
    if (!push) return 'unsupported';
    if (permission === 'denied') return 'denied';
    if (localStorage.getItem(DISABLED_KEY) === '1') return 'off';
    return permission === 'granted' ? 'granted' : 'can-enable';
  }
  if (!pushSupported()) return isIOS() && !isInstalledApp() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (localStorage.getItem(DISABLED_KEY) === '1') return 'off';
  return Notification.permission === 'granted' ? 'granted' : 'can-enable';
}

// Whether this is the desktop app with notifications on (it says so to the server).
export function desktopNotificationsOn() {
  return isDesktopApp() && localStorage.getItem(DISABLED_KEY) !== '1';
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(a, b) {
  if (!a) return true; // some browsers don't expose it; assume unchanged
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

// navigator.serviceWorker.ready never settles if no service worker is registered.
function serviceWorkerReady(timeoutMs = 10000) {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(t('app.push.noServiceWorker'))), timeoutMs)
    ),
  ]);
}

// Chrome-family browsers report their push service refusing or being unreachable as
// "Registration failed - push service error". That's the browser's setup, not Voicaw: Brave
// has its push service off by default, and Chromium builds without Google services have none.
export const PUSH_SERVICE_UNAVAILABLE = t('app.push.serviceUnavailable');

function explainSubscribeError(err) {
  if (/push service (error|not available)/i.test(err?.message || '')) {
    return Object.assign(new Error(PUSH_SERVICE_UNAVAILABLE), { cause: err });
  }
  return err;
}

// Makes sure this device has a push subscription for our VAPID key and that the server
// has it. Safe to call on every app start: subscriptions can change or expire.
export async function ensureSubscription(vapidPublicKey) {
  if (isDesktopApp()) return null;
  if (isAndroidApp()) {
    const subscription = await androidSubscription();
    await api.post('/save-subscription', { subscription });
    return subscription;
  }
  if (!vapidPublicKey) throw new Error('Missing VAPID public key');
  const registration = await serviceWorkerReady();
  const key = urlBase64ToUint8Array(vapidPublicKey);

  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options?.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
    } catch (err) {
      throw explainSubscribeError(err);
    }
  }

  await api.post('/save-subscription', { subscription: subscription.toJSON() });
  return subscription;
}

// Call directly from a click/tap handler: iOS only shows the permission prompt in response
// to a user gesture, and awaiting anything before requestPermission() loses the gesture.
export async function enableNotifications(vapidPublicKey) {
  if (isDesktopApp()) {
    localStorage.removeItem(DISABLED_KEY);
    refreshPresence();
    return 'granted';
  }
  if (isAndroidApp()) {
    const permission = await requestAndroidNotifications();
    if (permission !== 'granted') return permission;
    localStorage.removeItem(DISABLED_KEY);
    await ensureSubscription();
    return 'granted';
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  localStorage.removeItem(DISABLED_KEY);
  await ensureSubscription(vapidPublicKey);
  return 'granted';
}

// Stops notifications to this device: tells the server, then drops the subscription.
// `remember` keeps it off on future app starts (the user's choice); logout doesn't set it,
// so the next person to log in here gets notifications if the permission is granted.
// `timeout` (ms) gives up on the server (logout goes on without it); the browser's
// subscription is dropped either way. `token` sends the requests as that login (logout's).
export async function disableNotificationsOnThisDevice({ remember = false, timeout, token } = {}) {
  const config = {
    ...(timeout ? { timeout } : {}),
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
  const options = Object.keys(config).length ? [config] : [];
  if (remember) localStorage.setItem(DISABLED_KEY, '1');
  if (isDesktopApp()) {
    refreshPresence();
    return;
  }
  if (isAndroidApp()) {
    const { endpoint } = await androidSubscription();
    await api.post('/delete-subscription', { endpoint }, ...options);
    return;
  }
  if (!('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription) return;
  try {
    await api.post('/delete-subscription', { endpoint: subscription.endpoint }, ...options);
  } finally {
    await subscription.unsubscribe();
  }
}

// Resolves to { devices, delivered } for the current account.
export async function sendTestNotification() {
  const { data } = await api.post('/test-push');
  return data;
}
