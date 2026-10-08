import api from '../utils/api';
import { onConnectionState, onEmojiUsage } from '../utils/ws-client';
import { loadEncryptionKey, loadOwnPublicKeys } from '../services/keyStore';
import { decryptEmojiUsage, deriveEmojiUsageKey, encryptEmojiUsage } from '../services/encryptionService';

// Your emoji preferences (like Discord's "Frequently Used" and skin tone), following your
// account to every device. Which emoji you use says something about what you write in
// encrypted chats, so they're encrypted here with a key only your key pair derives
// (deriveEmojiUsageKey) and the server keeps one envelope it can't read (server/emojiUsage.js),
// as the spellcheck dictionary is (spellcheck/personalDictionary.js). A change counts at once
// and is saved a moment later (one save for a burst of emoji); a save made from an older
// version (another device saved first) is refused, so the newer copy is taken and this
// device's changes made again on top of it.

// Where they were kept per device before; moved into the account at its first login here.
const LEGACY_FREQUENT_KEY = 'emojiFrequent';
const LEGACY_SKIN_TONE_KEY = 'emojiSkinTone';
const SAVE_DELAY = 2000;

let counts = {}; // emoji id (custom: `custom:<id>`) -> uses
let tone; // 0-5, undefined if never chosen
let account = null; // { userId, key: Promise<CryptoKey | null>, version, saveDelay }
let unsaved = []; // [{ use: id, n } | { tone, legacy? }] not on the server yet, in order
let saving = false;
let saveTimer = null;

function apply(state, op) {
  if (op.use) state.counts[op.use] = (state.counts[op.use] || 0) + op.n;
  // A tone chosen before tones followed the account doesn't override the account's.
  else if (!(op.legacy && state.tone !== undefined)) state.tone = op.tone;
}

function change(op) {
  const state = { counts, tone };
  apply(state, op);
  ({ counts, tone } = state);
  unsaved.push(op);
  scheduleSave();
}

export function recordEmojiUse(id) {
  change({ use: id, n: 1 });
}

// Most used emoji ids, most used first.
export function frequentEmojiIds(limit = 16) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

// 0 = default (yellow), 1-5 = light to dark.
export function getSkinTone() {
  return tone ?? 0;
}

export function setSkinTone(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 5) change({ tone: value });
}

// The skin to use for an emoji given a tone (emoji without skin tones have one skin).
export function skinFor(emoji, skinTone) {
  return emoji.skins[emoji.skins.length === 6 ? skinTone : 0];
}

// What this device kept before (legacy localStorage), as changes to make to the account's.
function legacyChanges() {
  const ops = [];
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_FREQUENT_KEY));
    if (saved && typeof saved === 'object') {
      for (const [id, n] of Object.entries(saved)) if (Number.isInteger(n) && n > 0) ops.push({ use: id, n });
    }
    const savedTone = localStorage.getItem(LEGACY_SKIN_TONE_KEY);
    if (savedTone !== null && /^[0-5]$/.test(savedTone)) ops.push({ tone: Number(savedTone), legacy: true });
  } catch {
    // Unreadable: nothing to move.
  }
  return ops;
}

function forgetLegacy() {
  try {
    localStorage.removeItem(LEGACY_FREQUENT_KEY);
    localStorage.removeItem(LEGACY_SKIN_TONE_KEY);
  } catch {
    // Nothing to do.
  }
}

// The server's copy (`emojiUsage` envelope or null, `version`), with this device's unsaved
// changes on top.
async function takeRemote(current, { emojiUsage, version }) {
  const key = await current.key;
  if (!key || account !== current) return;
  let remote = { counts: {}, tone: undefined };
  if (emojiUsage) {
    try {
      remote = await decryptEmojiUsage(emojiUsage, key, current.userId);
    } catch (err) {
      console.warn("Couldn't read your emoji usage", err?.message);
      return;
    }
  }
  if (account !== current || version < current.version) return;
  current.version = version;
  current.loaded = true;
  const state = { counts: { ...remote.counts }, tone: remote.tone };
  unsaved.forEach((op) => apply(state, op));
  ({ counts, tone } = state);
}

// The server's copy from a load or another device's save. While a save is in flight it waits:
// it may be this device's own save coming back (the event can beat the reply), which already
// holds the uses still listed as unsaved, so taking it then would count them twice.
function receive(current, data) {
  if (!saving) {
    takeRemote(current, data);
    return;
  }
  if (!current.waiting || data.version > current.waiting.version) current.waiting = data;
}

function scheduleSave() {
  if (!account?.loaded) return; // saved once the account's own have arrived
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, account.saveDelay);
}

async function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const current = account;
  if (saving || !current?.loaded || !unsaved.length) return;
  saving = true;
  try {
    const key = await current.key;
    for (let tries = 0; key && account === current && unsaved.length && tries < 5; tries += 1) {
      const sending = unsaved.length;
      try {
        const emojiUsage = await encryptEmojiUsage(counts, tone, key, current.userId);
        const res = await api.put('/emoji-usage', { emojiUsage, version: current.version });
        current.version = Math.max(current.version, res.data.version);
        unsaved = unsaved.slice(sending);
      } catch (err) {
        if (err?.response?.status !== 409) throw err;
        await takeRemote(current, err.response.data);
      }
    }
    if (account === current && !unsaved.length) forgetLegacy();
  } catch (err) {
    // Kept on this device until the next change or reconnect.
    console.warn("Couldn't save your emoji usage", err?.message);
    return;
  } finally {
    saving = false;
    const { waiting } = current;
    current.waiting = null;
    if (waiting && waiting.version > current.version) takeRemote(current, waiting);
  }
  // Changed while saving.
  if (account === current && unsaved.length && !saveTimer) scheduleSave();
}

// Loads it for `userId` and keeps it current (the `emoji_usage` event, and again after a
// reconnect); -> a function that stops and forgets it (logging out). `saveDelay` is for tests.
export function startEmojiUsageSync(userId, { saveDelay = SAVE_DELAY } = {}) {
  const current = {
    userId,
    version: 0,
    loaded: false,
    waiting: null, // what arrived during a save (receive)
    saveDelay,
    key: Promise.all([loadEncryptionKey(), loadOwnPublicKeys()])
      .then(([mine, own]) => (mine && own?.encryptionKey ? deriveEmojiUsageKey(mine, own.encryptionKey) : null))
      .catch(() => null),
  };
  resetEmojiUsage();
  account = current;
  unsaved = legacyChanges();
  const load = () => api.get('/emoji-usage').then(
    (res) => (saving ? receive(current, res.data) : takeRemote(current, res.data).then(save)),
    (err) => console.warn('Failed to load your emoji usage', err?.message)
  );
  load();
  let wasOnline = true;
  const stopState = onConnectionState((state) => {
    if (state === 'online' && !wasOnline) load();
    wasOnline = state === 'online';
  });
  const stopEvents = onEmojiUsage((data) => {
    if (data.version > current.version) receive(current, data);
  });
  // Closing the app (or a phone switching away) saves what's waiting.
  const onHidden = () => {
    if (document.visibilityState === 'hidden' && saveTimer) save();
  };
  document.addEventListener('visibilitychange', onHidden);
  return () => {
    stopState();
    stopEvents();
    document.removeEventListener('visibilitychange', onHidden);
    if (account === current) resetEmojiUsage();
  };
}

// Back to nothing used and the default tone, with no account (logging out; tests).
export function resetEmojiUsage() {
  clearTimeout(saveTimer);
  saveTimer = null;
  account = null;
  counts = {};
  tone = undefined;
  unsaved = [];
}
