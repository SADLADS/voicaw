import { useSyncExternalStore } from 'react';
import { SOUNDS } from './soundList';
import { isDesktopApp } from '../utils/desktop';
import { isAndroidApp } from '../utils/android';
import { isMobileDevice } from '../utils/presence';
import { onAudioSettingsChange, outputSinkId } from '../voice/audioSettings';

// The app's sound effects (soundList.js has them all): played with one shared Web Audio
// context, as oscillator tones or, for a sound with a `file`, that file. Per device, the user
// picks a volume and which sounds play (Settings → Sounds, localStorage `soundPrefs`).
// Browsers only play sound once the page has had a click or key press; until then sounds are
// silently skipped.

const PREFS_KEY = 'soundPrefs';
const DEFAULT_PREFS = { volume: 1, off: [] };

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') ?? {};
    const volume = Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : DEFAULT_PREFS.volume;
    const off = Array.isArray(saved.off) ? saved.off.filter((name) => name in SOUNDS) : [];
    return { volume, off };
  } catch {
    return DEFAULT_PREFS;
  }
}

let prefs = loadPrefs();
const listeners = new Set();

export const getSoundPrefs = () => prefs;

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useSoundPrefs = () => useSyncExternalStore(subscribe, getSoundPrefs);

function savePrefs(next) {
  prefs = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered, then.
  }
  listeners.forEach((listener) => listener());
}

export function setSoundVolume(volume) {
  savePrefs({ ...prefs, volume: Math.min(1, Math.max(0, Number(volume) || 0)) });
}

export function setSoundEnabled(name, enabled) {
  const off = prefs.off.filter((n) => n !== name);
  savePrefs({ ...prefs, off: enabled ? off : [...off, name] });
}

export const isSoundOn = (name) => prefs.volume > 0 && !prefs.off.includes(name);

// Playing.

let context = null;

// Plays through the speakers chosen in Settings → Voice & video, where the browser can.
function applySink(ctx) {
  ctx?.setSinkId?.(outputSinkId()).catch?.(() => {});
}

onAudioSettingsChange((next, previous) => {
  if (context && next.outputDeviceId !== previous.outputDeviceId) applySink(context);
});

function audioContext() {
  if (typeof AudioContext === 'undefined') return null;
  if (!context) {
    context = new AudioContext();
    if (outputSinkId()) applySink(context);
  }
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
}

// Starts the audio context on the first click or key press (a context made before one stays
// suspended), so a sound that comes later (a message, a ring) can play.
if (typeof window !== 'undefined') {
  const unlock = () => {
    const ctx = audioContext();
    if (!ctx || ctx.state === 'running') {
      for (const type of ['pointerdown', 'keydown']) window.removeEventListener(type, unlock, true);
    }
  };
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, unlock, true);
}

const buffers = new Map(); // file → Promise<AudioBuffer | null>

function loadFile(ctx, file) {
  if (!buffers.has(file)) {
    buffers.set(file, fetch(file)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => ctx.decodeAudioData(data))
      .catch((err) => {
        console.warn(`Could not load the sound ${file}; using its tone`, err);
        return null;
      }));
  }
  return buffers.get(file);
}

function playTone(ctx, out, { notes, volume, wave = 'sine', shape = 'bell', detune = 0, filter = null }) {
  const start = ctx.currentTime + 0.02;
  // A lowpass closing from `filter.from` to `filter.to` Hz over `filter.length` s (a brassy stab).
  if (filter) {
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.Q.value = filter.q ?? 1;
    lowpass.frequency.setValueAtTime(filter.from, start);
    lowpass.frequency.exponentialRampToValueAtTime(filter.to, start + filter.length);
    lowpass.connect(out);
    out = lowpass;
  }
  // `detune` (cents): each note is two oscillators pulled apart by that much, for a thicker sound.
  const voices = detune ? [-detune, detune] : [0];
  for (const [at, frequency, length, cents] of notes.flatMap((note) => voices.map((cents) => [...note, cents]))) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = wave;
    oscillator.frequency.value = frequency;
    if (cents) oscillator.detune.value = cents;
    const from = start + at;
    const to = from + length;
    gain.gain.setValueAtTime(0, from);
    if (shape === 'flat') {
      gain.gain.linearRampToValueAtTime(volume, from + 0.02);
      gain.gain.setValueAtTime(volume, to - 0.05);
      gain.gain.linearRampToValueAtTime(0, to);
    } else {
      // Struck: a quick start, then fading away.
      gain.gain.linearRampToValueAtTime(volume, from + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, to);
    }
    oscillator.connect(gain).connect(out);
    oscillator.start(from);
    oscillator.stop(to);
  }
}

async function playInto(ctx, out, sound) {
  if (sound.file) {
    const buffer = await loadFile(ctx, sound.file);
    if (buffer) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      if (sound.fileVolume != null) {
        const gain = ctx.createGain();
        gain.gain.value = sound.fileVolume;
        source.connect(gain).connect(out);
      } else {
        source.connect(out);
      }
      source.start();
      return;
    }
  }
  playTone(ctx, out, sound.tone);
}

// A gain node at the user's volume for one sound (or loop), so it can be cut off.
function output(ctx) {
  const out = ctx.createGain();
  out.gain.value = prefs.volume;
  out.connect(ctx.destination);
  return out;
}

const lastPlayed = new Map();

// Plays a sound once, if it's on (`preview`: anyway, for Settings).
export function playSound(name, { preview = false } = {}) {
  const sound = SOUNDS[name];
  if (!sound || (!preview && !isSoundOn(name))) return;
  const now = Date.now();
  if (!preview && now - (lastPlayed.get(name) ?? -Infinity) < (sound.minGap ?? 100)) return;
  lastPlayed.set(name, now);
  try {
    const ctx = audioContext();
    if (!ctx) return;
    const out = output(ctx);
    playInto(ctx, out, sound).catch((err) => console.warn('Could not play a sound', err));
  } catch (err) {
    console.warn('Could not play a sound', err);
  }
}

// One looping sound at a time (the rings), every `every` ms until stopLoop().
let loop = null;

export function startLoop(name) {
  stopLoop();
  const sound = SOUNDS[name];
  if (!sound || !isSoundOn(name)) return;
  try {
    const ctx = audioContext();
    if (!ctx) return;
    const out = output(ctx);
    const play = () => playInto(ctx, out, sound).catch(() => {});
    play();
    loop = { out, timer: setInterval(play, sound.every ?? 3000) };
  } catch (err) {
    console.warn('Could not play a sound', err);
  }
}

export function stopLoop() {
  if (!loop) return;
  clearInterval(loop.timer);
  // Cuts off anything still sounding.
  loop.out.disconnect();
  loop = null;
}

// The server says a message arrived that you'd be notified about (server/push.js), in front
// of you or not. As in Discord, a page on a computer dings in a background tab or behind
// another window too (its system notification is then silent, see service-worker.js; Chrome's
// are often silent anyway), once its audio has started (a click since it loaded; until then
// the system notification makes the sound). On a phone, and in the Android app, the page only
// dings while it's in front: otherwise the phone's notification makes the sound. The desktop
// app always dings: its notifications are silent.
export function handlesMessageSound() {
  if (typeof document === 'undefined') return false;
  if (isDesktopApp()) return true;
  if (document.visibilityState === 'visible' && document.hasFocus()) return true;
  if (isMobileDevice() || isAndroidApp()) return false;
  return context?.state === 'running';
}

// Several tabs open in one browser ding once: whichever takes the lock first, held for the
// sound's minGap so the others find it taken.
const MESSAGE_SOUND_LOCK = 'voicaw-message-sound';

export function playMessageSound() {
  if (!handlesMessageSound()) return;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || isDesktopApp()) {
    playSound('message');
    return;
  }
  locks.request(MESSAGE_SOUND_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    playSound('message');
    await new Promise((resolve) => setTimeout(resolve, SOUNDS.message.minGap ?? 1000));
  }).catch(() => {});
}

// Before showing a message notification, the service worker asks the open pages whether one
// of them plays the sound itself (the notification then stays quiet).
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.action === 'handles-message-sound') {
      event.ports[0]?.postMessage(handlesMessageSound());
    }
  });
}
