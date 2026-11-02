import { describe, it, expect, vi } from 'vitest';
import { captureStreamSound, isStreamSoundDevice, STREAM_SOUND_LABEL } from './deviceStreamSound';

const mic = { kind: 'audioinput', deviceId: 'm1', label: 'Built-in microphone' };
const ours = { kind: 'audioinput', deviceId: 's1', label: STREAM_SOUND_LABEL };

describe('the desktop app\'s stream sound on Linux', () => {
  it('records the app\'s microphone once the browser lists it, untouched', async () => {
    const track = { kind: 'audio' };
    const enumerateDevices = vi.fn()
      .mockResolvedValueOnce([mic])
      .mockResolvedValue([mic, ours]);
    const getUserMedia = vi.fn(async () => ({ getAudioTracks: () => [track] }));
    expect(await captureStreamSound({ mediaDevices: { enumerateDevices, getUserMedia }, waitMs: 0 })).toBe(track);
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({
      deviceId: { exact: 's1' }, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    }) });
  });

  it('gives up if it never appears', async () => {
    const mediaDevices = { enumerateDevices: async () => [mic], getUserMedia: vi.fn() };
    await expect(captureStreamSound({ mediaDevices, tries: 3, waitMs: 0 })).rejects.toThrow();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('is no microphone to choose', () => {
    expect(isStreamSoundDevice(ours)).toBe(true);
    expect(isStreamSoundDevice(mic)).toBe(false);
  });
});
