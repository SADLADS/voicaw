import { useSyncExternalStore } from 'react';
import api from './api';

// Your settings that follow your account to every device (server/preferences.js), unlike
// utils/privacy's per-device ones. Defaults until loaded (hooks/usePreferencesSync.js, at login
// and after a reconnect); other devices' changes arrive as the `preferences` event.
// `blurNsfw`: media in NSFW guild channels is covered until clicked (on by default).

const DEFAULTS = { blurNsfw: true };
const listeners = new Set();
let prefs = DEFAULTS;

const notify = () => listeners.forEach((listener) => listener());

export function getPreferences() {
  return prefs;
}

// What the server sent (GET or PUT /preferences, or the `preferences` event).
export function applyPreferences(saved) {
  prefs = { ...DEFAULTS, ...saved };
  notify();
}

export function resetPreferences() {
  prefs = DEFAULTS;
  notify();
}

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
