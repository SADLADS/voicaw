import { useSyncExternalStore } from 'react';

// Settings → Privacy, per device (localStorage `privacy`, JSON; never sent to the server).
// Each choice trades a little privacy for convenience, and **defaults to the convenient one**;
// the more private one is there for whoever wants it.
// `inviteEmbedsInEncrypted`: invite cards in DMs and group DMs load by themselves (on by
// default). Asking the server about an invite tells it which invite an encrypted message held;
// turned off, the card waits for a tap on Show (guild channels always load them).

const STORAGE_KEY = 'privacy';
const DEFAULTS = { inviteEmbedsInEncrypted: true };
const listeners = new Set();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs = load();

export function getPrivacyPrefs() {
  return prefs;
}

export function setPrivacyPref(key, value) {
  prefs = { ...prefs, [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered, then.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrivacyPrefs() {
  return useSyncExternalStore(subscribe, getPrivacyPrefs);
}
