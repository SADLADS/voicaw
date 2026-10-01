import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_AUDIO_SETTINGS, captureOptions, cleanAudioSettings, getAudioSettings, inputGainStage,
  onAudioSettingsChange, processingChanged, resetAudioSettings, setAudioSettings,
} from './audioSettings';
import { levelOf } from './micTest';

const store = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
});

describe('voice settings (audioSettings.js)', () => {
  beforeEach(() => resetAudioSettings());

  it('keeps only sensible values', () => {
    expect(cleanAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(cleanAudioSettings({
      inputDeviceId: 'mic-2', outputDeviceId: 7, inputVolume: 9, outputVolume: -1, echoCancellation: false, noiseSuppression: 'no',
    })).toEqual({
      ...DEFAULT_AUDIO_SETTINGS, inputDeviceId: 'mic-2', inputVolume: 2, outputVolume: 0, echoCancellation: false,
    });
  });

  it('turns into microphone options, falling back when the device is gone', () => {
    expect(captureOptions()).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true });
    setAudioSettings({ inputDeviceId: 'mic-2', noiseSuppression: false });
    expect(captureOptions()).toEqual({
      deviceId: { ideal: 'mic-2' }, echoCancellation: true, noiseSuppression: false, autoGainControl: true, voiceIsolation: false,
    });
  });

  it('saves, tells listeners what changed, and moves live gains', () => {
    const gain = { gain: { value: 0 } };
    const stage = inputGainStage({ createGain: () => gain });
    expect(gain.gain.value).toBe(1);
    const seen = [];
    const stop = onAudioSettingsChange((next, previous) => seen.push([previous.inputVolume, next.inputVolume]));
    setAudioSettings({ inputVolume: 1.5 });
    expect(gain.gain.value).toBe(1.5);
    expect(seen).toEqual([[1, 1.5]]);
    expect(JSON.parse(store.get('audioSettings')).inputVolume).toBe(1.5);
    stage.destroy();
    setAudioSettings({ inputVolume: 0.5 });
    expect(gain.gain.value).toBe(1.5);
    stop();
    expect(getAudioSettings().inputVolume).toBe(0.5);
  });

  it('knows when the microphone has to be captured again', () => {
    const a = getAudioSettings();
    expect(processingChanged(a, { ...a, inputVolume: 2 })).toBe(false);
    expect(processingChanged(a, { ...a, autoGainControl: false })).toBe(true);
  });
});

describe('microphone level (micTest.js)', () => {
  it('is 0 for silence and 1 at full scale', () => {
    expect(levelOf(new Float32Array(128))).toBe(0);
    expect(levelOf(new Float32Array(128).fill(1))).toBe(1);
    const quiet = levelOf(new Float32Array(128).fill(0.01)); // -40 dB
    expect(quiet).toBeCloseTo(1 / 3, 2);
  });
});
