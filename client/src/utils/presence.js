// Everyone's online status: 'online' (active on a computer), 'mobile' (active only on a
// phone), 'idle' (connected, not active) or 'offline'. The server works it out (sockets.js)
// and sends a snapshot of everyone not offline each time this device (re)connects, then
// changes (`user_status`, with `lastOnline` when someone goes offline). Until the first
// snapshot, a user's own `status` / `last_online` fields (from the API) are used.

import { formatDate } from './dateFormat';

let haveSnapshot = false;
const statuses = new Map(); // user id (string) -> status, for everyone not offline
const lastOnlineById = new Map(); // user id -> unix seconds, from live offline events
let version = 0;
const listeners = new Set();

function changed() {
  version += 1;
  listeners.forEach((cb) => cb());
}

export function applyPresenceSnapshot(snapshot) {
  statuses.clear();
  for (const [userId, status] of Object.entries(snapshot ?? {})) statuses.set(String(userId), status);
  haveSnapshot = true;
  changed();
}

export function applyUserStatus({ userId, status, lastOnline }) {
  const id = String(userId);
  if (status === 'offline') statuses.delete(id);
  else statuses.set(id, status);
  if (lastOnline != null) lastOnlineById.set(id, lastOnline);
  changed();
}

// On logout.
export function resetPresence() {
  haveSnapshot = false;
  statuses.clear();
  lastOnlineById.clear();
  changed();
}

export function subscribePresence(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function getPresenceVersion() {
  return version;
}

// `user`: { id, status?, last_online? } -> { status, lastOnline } (lastOnline: unix s or null).
export function presenceOf(user) {
  const id = String(user.id);
  const status = haveSnapshot ? statuses.get(id) ?? 'offline' : user.status ?? 'offline';
  return { status, lastOnline: lastOnlineById.get(id) ?? user.last_online ?? null };
}

const STATUS_LABELS = { online: 'Online', mobile: 'Online on mobile', idle: 'Idle', offline: 'Offline' };

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? 'Offline';
}

// "Last seen 5 minutes ago" (null when never seen since this was recorded).
export function lastSeenText(lastOnline, now = Date.now()) {
  if (lastOnline == null) return null;
  const seconds = Math.max(0, Math.round(now / 1000 - lastOnline));
  if (seconds < 60) return 'Last seen just now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last seen ${rtf.format(-minutes, 'minute')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${rtf.format(-hours, 'hour')}`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Last seen ${rtf.format(-days, 'day')}`;
  return `Last seen ${formatDate(lastOnline * 1000)}`;
}

// Whether this device is a phone or tablet (not the chosen layout: someone on a computer
// using the mobile layout is still on a computer).
export function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  if (navigator.userAgentData?.mobile != null) {
    if (navigator.userAgentData.mobile) return true;
    // Chromium on Android tablets reports mobile: false.
    return /Android/i.test(navigator.userAgentData.platform ?? '');
  }
  const ua = navigator.userAgent ?? '';
  // iPadOS Safari says it's a Mac; a Mac has no touch screen.
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
