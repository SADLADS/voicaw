import { useSyncExternalStore } from 'react';
import api from './api';

// Your settings that follow your account to every device (server/preferences.js), unlike
// utils/privacy's per-device ones. Defaults until loaded (hooks/usePreferencesSync.js, at login
// and after a reconnect); other devices' changes arrive as the `preferences` event.
// `blurNsfw`: media in NSFW guild channels is covered until clicked (on by default).
// `adultConfirmed`: they ticked "I am 18 or over", which opens NSFW channels (guild/NsfwAgeGate).
// `botDms`: bots you share a guild with may message you (on by default; BotDm).
// `reactionNotifications`: 'all', 'dms' or 'off' (ReactionNotificationSettings).
// `showActivity`, `showMutualFriends`, `showMutualGuilds`: your profile's tabs others see (on
// by default; ProfileVisibilitySettings). `showActivity` off also deletes your game history.

const DEFAULTS = {
  blurNsfw: true, adultConfirmed: false, botDms: true, reactionNotifications: 'all',
  showActivity: true, showMutualFriends: true, showMutualGuilds: true,
};
const listeners = new Set();
let prefs = DEFAULTS;
// Whether the account's own have arrived (until then they're the defaults, which would show the
// age gate for a moment to someone who ticked long ago).
let loaded = false;

const notify = () => listeners.forEach((listener) => listener());

export function getPreferences() {
  return prefs;
}

// What the server sent (GET or PUT /preferences, or the `preferences` event).
export function applyPreferences(saved) {
  prefs = { ...DEFAULTS, ...saved };
  loaded = true;
  notify();
}

export function resetPreferences() {
  prefs = DEFAULTS;
  loaded = false;
  notify();
}

export const preferencesLoaded = () => loaded;

// Changes one at once here, then saves it; put back if saving fails.
export async function setPreference(key, value) {
  const before = prefs;
  prefs = { ...prefs, [key]: value };
  notify();
  try {
    applyPreferences((await api.put('/preferences', { [key]: value })).data);
  } catch (err) {
    prefs = before;
    notify();
    throw err;
  }
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePreferences() {
  return useSyncExternalStore(subscribe, getPreferences);
}

export function usePreferencesLoaded() {
  return useSyncExternalStore(subscribe, preferencesLoaded);
}
