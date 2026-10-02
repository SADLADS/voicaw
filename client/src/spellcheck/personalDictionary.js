import { useSyncExternalStore } from 'react';
import api from '../utils/api';
import { onConnectionState, onDictionary } from '../utils/ws-client';
import { loadEncryptionKey, loadOwnPublicKeys } from '../services/keyStore';
import { decryptDictionary, deriveDictionaryKey, encryptDictionary } from '../services/encryptionService';
import { desktop } from '../utils/desktop';

// Your own words for the spellchecker ("Add to Dictionary"), following your account to every
// device: encrypted here with a key only your key pair derives (deriveDictionaryKey) and kept
// by the server as one envelope it can't read (server/dictionary.js). A change shows at once
// and is saved in the background; a save made from an older version (another device saved
// first) is refused, so the newer copy is taken and the change made again on top of it.
// Words match whatever their case; they're listed as added.

let words = new Map(); // lower case -> as added
let snapshot = [];
let account = null; // { userId, key: Promise<CryptoKey | null>, version }
let unsaved = []; // [{ add | remove: word }] not on the server yet, in order
let saving = false;
const listeners = new Set();

function changed() {
  snapshot = [...words.values()].sort((a, b) => a.localeCompare(b));
  listeners.forEach((listener) => listener());
  // The desktop app's own checker (for languages we have no dictionary for) learns them too.
  desktop?.setSpellingWords?.(snapshot);
}

function apply(map, op) {
  if (op.add) map.set(op.add.toLowerCase(), op.add);
  else map.delete(op.remove.toLowerCase());
}

export function hasWord(word) {
  return words.has(word.toLowerCase());
}

export function dictionaryWords() {
  return snapshot;
}

export function subscribeDictionary(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDictionaryWords() {
  return useSyncExternalStore(subscribeDictionary, dictionaryWords);
}

function change(op) {
  apply(words, op);
  unsaved.push(op);
  changed();
  save();
}

export function addWord(word) {
  const clean = word.trim();
  if (clean && !hasWord(clean)) change({ add: clean });
}

export function removeWord(word) {
  if (hasWord(word)) change({ remove: word });
}

// The server's copy (`dictionary` envelope or null, `version`), with this device's unsaved
// changes on top.
async function takeRemote(current, { dictionary, version }) {
  const key = await current.key;
  if (!key || account !== current) return;
  let remote = [];
  if (dictionary) {
    try {
      remote = await decryptDictionary(dictionary, key, current.userId);
    } catch (err) {
      console.warn("Couldn't read your dictionary", err?.message);
      return;
    }
  }
  if (account !== current || version < current.version) return;
  current.version = version;
  const next = new Map(remote.map((word) => [word.toLowerCase(), word]));
  unsaved.forEach((op) => apply(next, op));
  words = next;
  changed();
}

async function save() {
  const current = account;
  if (saving || !current || !unsaved.length) return;
  saving = true;
  try {
    const key = await current.key;
    for (let tries = 0; key && account === current && unsaved.length && tries < 5; tries += 1) {
      const sending = unsaved.length;
      try {
        const dictionary = await encryptDictionary(snapshot, key, current.userId);
        const res = await api.put('/dictionary', { dictionary, version: current.version });
        current.version = Math.max(current.version, res.data.version);
        unsaved = unsaved.slice(sending);
      } catch (err) {
        if (err?.response?.status !== 409) throw err;
        await takeRemote(current, err.response.data);
      }
    }
  } catch (err) {
    // Kept on this device until the next change or reconnect.
    console.warn("Couldn't save your dictionary", err?.message);
  } finally {
    saving = false;
  }
}

// Loads it for `userId` and keeps it current (the `dictionary` event, and again after a
// reconnect); -> a function that stops and forgets it (logging out).
export function startDictionarySync(userId) {
  const current = {
    userId,
    version: 0,
    key: Promise.all([loadEncryptionKey(), loadOwnPublicKeys()])
      .then(([mine, own]) => (mine && own?.encryptionKey ? deriveDictionaryKey(mine, own.encryptionKey) : null))
      .catch(() => null),
  };
  account = current;
  const load = () => api.get('/dictionary').then(
    (res) => takeRemote(current, res.data).then(save),
    (err) => console.warn('Failed to load your dictionary', err?.message)
  );
  load();
  let wasOnline = true;
  const stopState = onConnectionState((state) => {
    if (state === 'online' && !wasOnline) load();
    wasOnline = state === 'online';
  });
  const stopEvents = onDictionary((data) => {
    if (data.version > current.version) takeRemote(current, data);
  });
  return () => {
    stopState();
    stopEvents();
    if (account !== current) return;
    account = null;
    words = new Map();
    unsaved = [];
    changed();
  };
}
