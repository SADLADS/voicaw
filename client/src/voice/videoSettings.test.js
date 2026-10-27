import { describe, expect, it } from 'vitest';
import { cameraOptions, cleanVideoSettings, DEFAULT_VIDEO_SETTINGS } from './videoSettings';

describe('videoSettings', () => {
  it('keeps a saved camera and drops anything else', () => {
    expect(cleanVideoSettings({ cameraDeviceId: 'abc', other: 1 })).toEqual({ cameraDeviceId: 'abc' });
    expect(cleanVideoSettings({ cameraDeviceId: 5 })).toEqual(DEFAULT_VIDEO_SETTINGS);
    expect(cleanVideoSettings({ cameraDeviceId: 'x'.repeat(513) })).toEqual(DEFAULT_VIDEO_SETTINGS);
    expect(cleanVideoSettings(null)).toEqual(DEFAULT_VIDEO_SETTINGS);
  });

  it('asks for the chosen camera, or the front one, at 720p', () => {
    expect(cameraOptions({ cameraDeviceId: '' })).toEqual({
      facingMode: 'user', resolution: { width: 1280, height: 720, frameRate: 30 },
    });
    expect(cameraOptions({ cameraDeviceId: 'abc' })).toEqual({
      deviceId: { ideal: 'abc' }, resolution: { width: 1280, height: 720, frameRate: 30 },
    });
  });

  it("asks for a phone's front or back camera once switched, over the chosen one", () => {
    expect(cameraOptions({ cameraDeviceId: 'abc' }, 'environment')).toEqual({
      facingMode: 'environment', resolution: { width: 1280, height: 720, frameRate: 30 },
    });
  });
});
