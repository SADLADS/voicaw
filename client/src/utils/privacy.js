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
// `linkPreviews`: pictures and videos from other sites in link previews (and links straight to
// a picture or a video, in any chat) load at once (on by default), which tells those sites your
// IP address and what you were sent; turned off, each waits for a tap on Show. A guild preview's
// text comes from our server, so it shows either way (see docs/messages.md, Link previews).
// `showLinkPreviews`: links to other sites get a preview at all (on by default): a guild's
// cards, a picture or video linked in any chat, a YouTube player. Turned off, only the link
// shows (Voicaw's own invite and event cards, and bots' embeds, still do).
// `searchCopy`: searching a DM, group DM or your notes keeps an encrypted copy of it on the
// device, so the next search doesn't read the whole history from the server again (on by
// default; services/searchIndex.js). Turned off, the copy is deleted and every search reads it
// all again.
// `offlineCopy`: DMs, group DMs and your notes, as this device has shown them, are kept on it
// (encrypted) so they can be read without a connection (on by default;
// services/offlineCopy.js). Turned off, the copy is deleted and nothing is kept.
// `safetyNumbers`: DMs show a Verified / Not verified badge that opens the safety number to
// compare with the contact (off by default: confusing for most people, and nothing is given up
// without it: keys are pinned and a changed key blocks the chat either way).
// Notification previews are Settings → Privacy too, but kept in services/settingsStore (the
// service worker reads them).

const STORAGE_KEY = 'privacy';
const DEFAULTS = { inviteEmbedsInEncrypted: true, sendTyping: true, youtubeEmbeds: true, gifs: true, linkPreviews: true, showLinkPreviews: true, searchCopy: true, offlineCopy: true, safetyNumbers: false };
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
