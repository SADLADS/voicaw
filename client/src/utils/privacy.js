import { useSyncExternalStore } from 'react';

// Settings → Privacy, per device (localStorage `privacy`, JSON; never sent to the server).
// Each choice trades a little privacy for convenience, and **defaults to the convenient one**;
// the more private one is there for whoever wants it.
// `inviteEmbedsInEncrypted`: invite cards in DMs and group DMs load by themselves (on by
// default). Asking the server about an invite tells it which invite an encrypted message held;
// turned off, the card waits for a tap on Show (guild channels always load them).
// `sendTyping`: the others in a chat see "… is typing" while you write (on by default). In DMs
// and group DMs that tells the server when you're typing to whom (never what).
// `youtubeEmbeds`: YouTube links get a player at once (on by default). Even before it's
// played, the player tells YouTube your IP address and which video you were sent; turned off,
// a placeholder (no thumbnail, which would tell it too) waits for a tap on Play.
// `gifs`: GIFs in messages and the GIF picker's previews load from Klipy at once (on by
// default), which tells Klipy your IP address and which GIFs you see; turned off, each GIF in a
// message waits for a tap on Show, and the picker asks first.

const STORAGE_KEY = 'privacy';
const DEFAULTS = { inviteEmbedsInEncrypted: true, sendTyping: true, youtubeEmbeds: true, gifs: true };
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
