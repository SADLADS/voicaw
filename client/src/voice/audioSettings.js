import { useSyncExternalStore } from 'react';

// Voice settings on this device (Settings → Voice & video, localStorage `audioSettings`):
// which microphone and speakers, their volumes, and what the browser does to the microphone
// (echo cancellation, noise suppression, automatic gain). voiceClient.js applies them to the
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
  noiseSuppression: true,
  autoGainControl: true,
};

const clamp = (value, min, max, fallback) =>
  (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

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
    noiseSuppression: bool('noiseSuppression'),
    autoGainControl: bool('autoGainControl'),
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
// falls back to another rather than failing. Voice isolation (Chrome's stronger noise
// suppression) goes with noise suppression.
export function captureOptions(s = settings) {
  return {
    ...(s.inputDeviceId ? { deviceId: { ideal: s.inputDeviceId } } : {}),
    echoCancellation: s.echoCancellation,
    noiseSuppression: s.noiseSuppression,
    autoGainControl: s.autoGainControl,
    voiceIsolation: s.noiseSuppression,
  };
}

// Whether the processing changed (the microphone has to be captured again for that).
export const processingChanged = (a, b) =>
  a.echoCancellation !== b.echoCancellation || a.noiseSuppression !== b.noiseSuppression ||
  a.autoGainControl !== b.autoGainControl;

// The speakers, for setSinkId ('' is the default).
export const outputSinkId = (s = settings) => s.outputDeviceId || '';

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
// `labelled` is false until the page may use the microphone (browsers hide names until then).
// The browser's own "default" entry is left out ('' stands for it); `defaults` has its name.
export async function listAudioDevices() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [], labelled: false, defaults: {} };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const defaults = {};
  const pick = (kind) => devices
    .filter((d) => d.kind === kind)
    .filter((d) => {
      if (d.deviceId !== 'default') return true;
      defaults[kind === 'audioinput' ? 'input' : 'output'] = d.label.replace(/^Default\s*-\s*/i, '') || null;
      return false;
    })
    .map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Microphone' : 'Speakers'} ${i + 1}` }));
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
