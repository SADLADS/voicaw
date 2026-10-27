import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_AUDIO_SETTINGS, canChooseInput, captureOptions, cleanAudioSettings, gateOptions, getAudioSettings, inputGainStage,
  listAudioDevices, onAudioSettingsChange, processingChanged, resetAudioSettings, setAudioSettings,
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
      autoSensitivity: 'yes', sensitivity: -400,
    })).toEqual({
      ...DEFAULT_AUDIO_SETTINGS, inputDeviceId: 'mic-2', inputVolume: 2, outputVolume: 0, echoCancellation: false, sensitivity: -100,
    });
  });

  it('keeps push to talk to its modes, known keys and up to 2 s of delay', () => {
    expect(DEFAULT_AUDIO_SETTINGS).toMatchObject({ inputMode: 'voice', pushToTalkKey: null, pushToTalkDelay: 20 });
    expect(cleanAudioSettings({ inputMode: 'pushToTalk', pushToTalkKey: 'Backquote', pushToTalkDelay: 250.4 }))
      .toMatchObject({ inputMode: 'pushToTalk', pushToTalkKey: 'Backquote', pushToTalkDelay: 250 });
    expect(cleanAudioSettings({ inputMode: 'shout', pushToTalkKey: 'Escape', pushToTalkDelay: 99999 }))
      .toMatchObject({ inputMode: 'voice', pushToTalkKey: null, pushToTalkDelay: 2000 });
    expect(cleanAudioSettings({ pushToTalkKey: 'Mouse4', pushToTalkDelay: -5 })).toMatchObject({ pushToTalkKey: 'Mouse4', pushToTalkDelay: 0 });
  });

  it('opens the gate wide with push to talk (the key decides)', () => {
    setAudioSettings({ autoSensitivity: false, sensitivity: -30 });
    expect(gateOptions()).toEqual({ auto: false, thresholdDb: -30 });
    setAudioSettings({ inputMode: 'pushToTalk' });
    expect(gateOptions()).toEqual({ auto: false, thresholdDb: -100 });
  });

  it('turns noise suppression saved as on/off into Standard/Off', () => {
    expect(DEFAULT_AUDIO_SETTINGS.noiseSuppression).toBe('standard');
    expect(cleanAudioSettings({ noiseSuppression: true }).noiseSuppression).toBe('standard');
    expect(cleanAudioSettings({ noiseSuppression: false }).noiseSuppression).toBe('off');
    expect(cleanAudioSettings({ noiseSuppression: 'strong' }).noiseSuppression).toBe('strong');
  });

  it('turns into microphone options, with the browser suppressing noise only when chosen', () => {
    expect(captureOptions()).toEqual({ echoCancellation: true, noiseSuppression: false, autoGainControl: true, voiceIsolation: false });
    setAudioSettings({ inputDeviceId: 'mic-2', noiseSuppression: 'browser' });
    expect(captureOptions()).toEqual({
      deviceId: { ideal: 'mic-2' }, echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true,
    });
    setAudioSettings({ noiseSuppression: 'strong' });
    expect(captureOptions().noiseSuppression).toBe(false);
  });

  it("gives the gate's options", () => {
    expect(gateOptions()).toEqual({ auto: true, thresholdDb: -50 });
    setAudioSettings({ autoSensitivity: false, sensitivity: -32 });
    expect(gateOptions()).toEqual({ auto: false, thresholdDb: -32 });
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
    expect(processingChanged(a, { ...a, noiseSuppression: 'strong' })).toBe(true);
    expect(processingChanged(a, { ...a, autoSensitivity: false, sensitivity: -20 })).toBe(false);
  });
});

describe('devices (audioSettings.js)', () => {
  const withDevices = (devices, userAgent = 'Mozilla/5.0 (X11; Linux x86_64)') => vi.stubGlobal('navigator', {
    userAgent, mediaDevices: { enumerateDevices: async () => devices },
  });
  const device = (kind, deviceId, label) => ({ kind, deviceId, label });
  beforeEach(() => resetAudioSettings());

  it('lists the devices, leaving the default entry out but keeping its name', async () => {
    withDevices([
      device('audioinput', 'default', 'Default - Headset Mic'), device('audioinput', 'a1', 'Headset Mic'),
      device('audioinput', 'a2', 'Webcam Mic'), device('audiooutput', 'default', 'Default - Speakers'),
      device('audiooutput', 'o1', 'Speakers'), device('videoinput', 'v1', 'Webcam'),
    ]);
    expect(await listAudioDevices()).toEqual({
      inputs: [{ id: 'a1', label: 'Headset Mic' }, { id: 'a2', label: 'Webcam Mic' }],
      outputs: [{ id: 'o1', label: 'Speakers' }],
      labelled: true,
      defaults: { input: 'Headset Mic', output: 'Speakers' },
    });
  });

  it("leaves out the placeholders browsers list before the microphone is allowed", async () => {
    withDevices([device('audioinput', '', ''), device('audiooutput', '', ''), device('videoinput', '', '')]);
    expect(await listAudioDevices()).toEqual({ inputs: [], outputs: [], labelled: false, defaults: {} });
  });

  it('always uses the default microphone on a phone, even one chosen before', () => {
    setAudioSettings({ inputDeviceId: 'mic-2' });
    withDevices([]);
    expect(canChooseInput()).toBe(true);
    expect(captureOptions().deviceId).toEqual({ ideal: 'mic-2' });
    withDevices([], 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36');
    expect(canChooseInput()).toBe(false);
    expect(captureOptions().deviceId).toBeUndefined();
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
