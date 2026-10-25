import { useSyncExternalStore } from 'react';
import { ALWAYS_OPEN_DB } from './noise/gate';
import { t } from '../i18n';
import { isMobileDevice } from '../utils/presence';

// Voice settings on this device (Settings → Voice & video, localStorage `audioSettings`):
// which microphone and speakers, their volumes, what's done to the microphone (echo
// cancellation and automatic gain by the browser; noise suppression; the gate's input
// sensitivity, see noise/gate.js), and whether and how loud soundboard and join sounds play. voiceClient.js applies them to the
// call you're in as they change; the microphone test (micTest.js) and the app's sounds use
// them too. Device ids are the browser's, so they only mean something on this device; one
// that's gone (unplugged) falls back to the system's default.

const KEY = 'audioSettings';

export const DEFAULT_AUDIO_SETTINGS = {
  inputDeviceId: '', // '': the system's default
  outputDeviceId: '',
  inputVolume: 1, // 0–2: a gain on the microphone, before it's sent
  outputVolume: 1, // 0–1: everyone else's voices
  echoCancellation: true,
  noiseSuppression: 'standard', // one of NOISE_SUPPRESSION
  autoGainControl: true,
  autoSensitivity: true, // the gate opens on speech (RNNoise's); else on loudness:
  sensitivity: -50, // dB, -100 (ALWAYS_OPEN_DB) to 0
  // Soundboards (voice/soundboard.js): the guild's sounds others play, and the join sounds
  // played when someone joins, each heard or not and at its own volume (0–1).
  soundboardOn: true,
  soundboardVolume: 1,
  joinSoundsOn: true,
  joinSoundVolume: 1,
};

// Noise suppression: Standard is RNNoise (noise/rnnoise.js), Strong DeepFilterNet
// (noise/deepFilterWorklet.js, a big download, computers only), Browser the browser's own
// (with Chrome's voiceIsolation), Off nothing. Only one ever runs: two in a row make a voice
// sound worse.
export const NOISE_SUPPRESSION = ['standard', 'strong', 'browser', 'off'];

const clamp = (value, min, max, fallback) =>
  (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

// Saved before the modes, it was on (now Standard) or off.
function noiseMode(value) {
  if (NOISE_SUPPRESSION.includes(value)) return value;
  if (value === false) return 'off';
  return DEFAULT_AUDIO_SETTINGS.noiseSuppression;
}

export function cleanAudioSettings(raw) {
  const d = DEFAULT_AUDIO_SETTINGS;
  const saved = raw && typeof raw === 'object' ? raw : {};
  const bool = (key) => (typeof saved[key] === 'boolean' ? saved[key] : d[key]);
  const id = (key) => (typeof saved[key] === 'string' && saved[key].length <= 512 ? saved[key] : d[key]);
  return {
    inputDeviceId: id('inputDeviceId'),
    outputDeviceId: id('outputDeviceId'),
    inputVolume: clamp(saved.inputVolume, 0, 2, d.inputVolume),
    outputVolume: clamp(saved.outputVolume, 0, 1, d.outputVolume),
    echoCancellation: bool('echoCancellation'),
    noiseSuppression: noiseMode(saved.noiseSuppression),
    autoGainControl: bool('autoGainControl'),
    autoSensitivity: bool('autoSensitivity'),
    sensitivity: clamp(saved.sensitivity, ALWAYS_OPEN_DB, 0, d.sensitivity),
    soundboardOn: bool('soundboardOn'),
    soundboardVolume: clamp(saved.soundboardVolume, 0, 1, d.soundboardVolume),
    joinSoundsOn: bool('joinSoundsOn'),
    joinSoundVolume: clamp(saved.joinSoundVolume, 0, 1, d.joinSoundVolume),
  };
}

function load() {
  try {
    return cleanAudioSettings(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return DEFAULT_AUDIO_SETTINGS;
  }
}

let settings = load();
const listeners = new Set();

export const getAudioSettings = () => settings;

export function onAudioSettingsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useAudioSettings = () => useSyncExternalStore(onAudioSettingsChange, getAudioSettings);

export function setAudioSettings(changes) {
  const previous = settings;
  settings = cleanAudioSettings({ ...settings, ...changes });
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not remembered, then.
  }
  for (const gain of inputGains) gain.gain.value = settings.inputVolume;
  for (const listener of listeners) listener(settings, previous);
}

export function resetAudioSettings() {
  setAudioSettings(DEFAULT_AUDIO_SETTINGS);
}

// The microphone as LiveKit (and getUserMedia) take it. `ideal`, so a device that's gone
// falls back to another rather than failing. The browser's noise suppression (and voice
// isolation, Chrome's stronger one) only when it's the one chosen.
export function captureOptions(s = settings) {
  const browserSuppression = s.noiseSuppression === 'browser';
  return {
    ...(s.inputDeviceId && canChooseInput() ? { deviceId: { ideal: s.inputDeviceId } } : {}),
    echoCancellation: s.echoCancellation,
    noiseSuppression: browserSuppression,
    autoGainControl: s.autoGainControl,
    voiceIsolation: browserSuppression,
  };
}

// Whether the processing changed: the microphone has to be captured again (and the chain
// rebuilt) for that. The gate's settings apply live.
export const processingChanged = (a, b) =>
  a.echoCancellation !== b.echoCancellation || a.noiseSuppression !== b.noiseSuppression ||
  a.autoGainControl !== b.autoGainControl;

// The gate's options (noise/gate.js).
export const gateOptions = (s = settings) => ({
  auto: s.autoSensitivity,
  thresholdDb: s.sensitivity,
});

// The speakers, for setSinkId ('' is the default).
export const outputSinkId = (s = settings) => s.outputDeviceId || '';

// Phones and tablets always use their default microphone (the system switches it to a
// headset by itself), so there's nothing to choose, and one chosen before is ignored.
export const canChooseInput = () => !isMobileDevice();

// Can this browser choose where sound plays? (Not Safari, nor Firefox before 116.)
export const canChooseOutput = () =>
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

// A voice chain stage (voiceChain.js) at the input volume, kept current as it changes.
const inputGains = new Set();

export function inputGainStage(context) {
  const gain = context.createGain();
  gain.gain.value = settings.inputVolume;
  inputGains.add(gain);
  return { input: gain, output: gain, destroy: () => inputGains.delete(gain) };
}

// The microphones and speakers, as { inputs, outputs: [{ id, label }], labelled, defaults }.
// `labelled` is false until the page may use the microphone: browsers hide names until then,
// listing one placeholder of each kind with no id, which is left out (it isn't a device to
// choose). The browser's own "default" entry is left out too ('' stands for it); `defaults`
// has its name.
export async function listAudioDevices() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [], labelled: false, defaults: {} };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const defaults = {};
  const pick = (kind) => devices
    .filter((d) => d.kind === kind && d.deviceId)
    .filter((d) => {
      if (d.deviceId !== 'default') return true;
      defaults[kind === 'audioinput' ? 'input' : 'output'] = d.label.replace(/^Default\s*-\s*/i, '') || null;
      return false;
    })
    .map((d, i) => ({ id: d.deviceId, label: d.label || (kind === 'audioinput'
      ? t('settings.voice.microphoneNumbered', { number: i + 1 })
      : t('settings.voice.speakersNumbered', { number: i + 1 })) }));
  const inputs = pick('audioinput');
  const outputs = pick('audiooutput');
  const labelled = devices.some((d) => d.kind === 'audioinput' && d.label);
  return { inputs, outputs, labelled, defaults };
}

export function onDeviceChange(listener) {
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (!devices?.addEventListener) return () => {};
  devices.addEventListener('devicechange', listener);
  return () => devices.removeEventListener('devicechange', listener);
}
