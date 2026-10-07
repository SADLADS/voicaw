import { Capacitor, registerPlugin } from '@capacitor/core';

// The Android app (mobile/): `android` is its native plugin (mobile/android/.../VoicawPlugin.java),
// or null anywhere else. Everything the Android app adds goes through here, as the desktop
// app's does through utils/desktop.js.

const isAndroidPlatform = typeof window !== 'undefined' && Capacitor.getPlatform() === 'android';

export const android = isAndroidPlatform ? registerPlugin('Voicaw') : null;

export const isAndroidApp = () => android !== null;

// What the app last said about notifications on this phone: { permission: 'granted' |
// 'denied' | 'prompt', fullScreen (may ring over the lock screen), push (Firebase is set up in
// this build) }. Read at start (main.jsx) and after asking, so getPushStatus() can stay
// synchronous.
let nativeState = { permission: 'prompt', fullScreen: false, push: false };

export const androidNotificationState = () => nativeState;

export async function refreshAndroidNotificationState() {
  if (!android) return nativeState;
  try {
    nativeState = { ...nativeState, ...(await android.checkNotifications()) };
  } catch (err) {
    console.warn('Could not check notifications', err);
  }
  return nativeState;
}

export async function requestAndroidNotifications() {
  const { permission } = await android.requestNotifications();
  nativeState = { ...nativeState, permission };
  return permission;
}

// The subscription the server keeps for this phone (server/push.js `sendFcm`): its Firebase
// token, and the key it encrypts each push with, so Firebase only relays ciphertext.
export async function androidSubscription() {
  const { token, key } = await android.getPushToken();
  return { endpoint: `fcm:${token}`, fcm: { token, key } };
}

// The ongoing-call notification (`title`: what the voice bar links to, `status`: its state,
// `labels`: the buttons' text) or null when not in voice. While it's shown, Android keeps the
// app and its microphone running with the screen off; its buttons mute and hang up.
export function ongoingNotification(voice, { title, status, labels }) {
  if (voice.status === 'idle') return null;
  return {
    title,
    text: status,
    muted: Boolean(voice.selfMute || voice.selfDeaf),
    inCall: voice.callId != null,
    labels,
  };
}

// Whether two ongoingNotification() results would show the same thing.
export function sameOngoing(a, b) {
  if (!a || !b) return a === b;
  return a.title === b.title && a.text === b.text && a.muted === b.muted && a.inCall === b.inCall;
}

// The colour behind Android's status and navigation bars, and whether their icons go dark (a
// light theme): the app pads itself clear of the bars (MainActivity), so this is what shows
// there. The frame's colour (the list pane's), so it reads as part of the app.
export function setAndroidSystemBars(light) {
  if (!android || typeof document === 'undefined') return;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--vc-bg-base').trim();
  if (!color) return;
  android.setSystemBars({ color, light }).catch((err) => console.warn('Could not colour the system bars', err));
}

// Pieces of a file sent to the app at a time (as base64, through Capacitor's bridge).
export const SAVE_CHUNK = 512 * 1024;

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Saves `blob` to the phone's Downloads folder as `name` (VoicawPlugin `saveFile*`): the WebView
// ignores <a download>, and only the page can read its blob: URLs. With `open`, then opens it
// in the app that handles its type. Resolves { opened }.
export async function saveToDownloads(blob, name, { open = false } = {}, plugin = android) {
  const { id } = await plugin.saveFileStart({ name, type: blob.type || '' });
  try {
    for (let at = 0; at < blob.size; at += SAVE_CHUNK) {
      const bytes = new Uint8Array(await blob.slice(at, at + SAVE_CHUNK).arrayBuffer());
      await plugin.saveFileAppend({ id, data: toBase64(bytes) });
    }
  } catch (err) {
    plugin.saveFileCancel({ id }).catch(() => {});
    throw err;
  }
  return plugin.saveFileFinish({ id, open });
}

// The phone's photos and videos, for the message box's + panel (VoicawPlugin `*Media*`, Media.java).
// Access is 'all', 'some' (Android 14+: only those the person chose; asking again lets them
// choose more) or 'none'.
export const mediaAccess = async () => (await android.mediaAccess()).access;
export const requestMediaAccess = async () => (await android.requestMediaAccess()).access;

// Newest first: [{ id, uri, type, name, size, duration (ms, videos) }].
export const listMedia = async (offset, limit) => (await android.listMedia({ offset, limit })).items;

// A data: URL of a small picture of `item`.
export const mediaThumbnail = async (item, size = 256) => (await android.mediaThumbnail({ uri: item.uri, size })).url;

// The file itself, read by the page through Capacitor's server (`_capacitor_content_`), which
// serves the app's content:// files: only once it's picked.
export async function readMedia(item) {
  const res = await fetch(Capacitor.convertFileSrc(item.uri));
  if (!res.ok) throw new Error(`Couldn't read ${item.name} (${res.status})`);
  return new File([await res.blob()], item.name, { type: item.type || '' });
}

export function showAndroidToast(message) {
  android?.showToast({ message }).catch(() => {});
}
