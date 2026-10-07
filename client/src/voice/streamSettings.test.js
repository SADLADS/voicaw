import { describe, expect, it } from 'vitest';
import {
  clampStream, cleanStreamLimit, cleanStreamSettings, DEFAULT_STREAM_SETTINGS, frameRateAllowed, resolutionAllowed, screenShareOptions,
} from './streamSettings';

describe('streamSettings', () => {
  it('keeps a saved quality and drops anything else', () => {
    expect(cleanStreamSettings({ resolution: '720', frameRate: 60, other: 1 })).toEqual({ resolution: '720', frameRate: 60 });
    expect(cleanStreamSettings({ resolution: '4k', frameRate: 24 })).toEqual(DEFAULT_STREAM_SETTINGS);
    expect(cleanStreamSettings({ resolution: 720, frameRate: '30' })).toEqual(DEFAULT_STREAM_SETTINGS);
    expect(cleanStreamSettings(null)).toEqual(DEFAULT_STREAM_SETTINGS);
  });

  it('reads a missing or unknown cap as no cap', () => {
    expect(cleanStreamLimit(null)).toEqual({ resolution: 'source', frameRate: 60 });
    expect(cleanStreamLimit({ resolution: '480', frameRate: 25 })).toEqual({ resolution: 'source', frameRate: 60 });
    expect(cleanStreamLimit({ resolution: '720', frameRate: 15 })).toEqual({ resolution: '720', frameRate: 15 });
  });

  it('brings a choice above the cap down to it', () => {
    const cap = { resolution: '1080', frameRate: 30 };
    expect(clampStream({ resolution: 'source', frameRate: 60 }, cap)).toEqual({ resolution: '1080', frameRate: 30 });
    expect(clampStream({ resolution: '720', frameRate: 15 }, cap)).toEqual({ resolution: '720', frameRate: 15 });
    expect(clampStream({ resolution: 'source', frameRate: 60 }, null)).toEqual({ resolution: 'source', frameRate: 60 });
    expect(resolutionAllowed('source', cap)).toBe(false);
    expect(resolutionAllowed('1080', cap)).toBe(true);
    expect(frameRateAllowed(60, cap)).toBe(false);
    expect(frameRateAllowed(30, cap)).toBe(true);
  });

  it('captures at most the chosen height, sharp for reading at 15 fps and smooth above', () => {
    expect(screenShareOptions({ resolution: '720', frameRate: 15 })).toEqual({
      capture: {
        resolution: { width: 0, height: 0 },
        video: { frameRate: { ideal: 15, max: 15 }, width: { max: 1280 }, height: { max: 720 } },
        contentHint: 'detail',
      },
      publish: { screenShareEncoding: { maxBitrate: 1_500_000, maxFramerate: 15 } },
    });
    // The screen's own size: no size asked for.
    expect(screenShareOptions({ resolution: 'source', frameRate: 60 })).toEqual({
      capture: { resolution: { width: 0, height: 0 }, video: { frameRate: { ideal: 60, max: 60 } }, contentHint: 'motion' },
      publish: { screenShareEncoding: { maxBitrate: 10_000_000, maxFramerate: 60 } },
    });
  });
});
