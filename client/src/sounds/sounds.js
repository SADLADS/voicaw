import { useSyncExternalStore } from 'react';
import { SOUNDS } from './soundList';
import { isDesktopApp } from '../utils/desktop';
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

function playTone(ctx, out, { notes, volume, wave = 'sine', shape = 'bell' }) {
  const start = ctx.currentTime + 0.02;
  for (const [at, frequency, length] of notes) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = wave;
    oscillator.frequency.value = frequency;
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
      source.connect(out);
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

// The server says a message arrived that you'd be notified about (server/push.js). In a
// browser the page plays the sound only while it's in front (its system notification is then
// silent, see service-worker.js); otherwise that notification makes the system's sound. The
// desktop app always plays it: its notifications are silent.
export function playMessageSound() {
  const inFront = typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
  if (isDesktopApp() || inFront) playSound('message');
}
