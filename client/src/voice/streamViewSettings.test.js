import { describe, expect, it, vi } from 'vitest';
import {
  cleanViewQuality, getStreamViewQuality, onStreamViewQualityChange, setStreamViewQuality,
} from './streamViewSettings';

describe('streamViewSettings', () => {
  it('keeps a known quality and reads anything else as auto', () => {
    expect(cleanViewQuality('low')).toBe('low');
    expect(cleanViewQuality('high')).toBe('auto');
    expect(cleanViewQuality(null)).toBe('auto');
  });

  it('tells listeners of a change, once', () => {
    const listener = vi.fn();
    const off = onStreamViewQualityChange(listener);
    setStreamViewQuality('low');
    setStreamViewQuality('low');
    expect(getStreamViewQuality()).toBe('low');
    expect(listener).toHaveBeenCalledTimes(1);
    setStreamViewQuality('nonsense');
    expect(getStreamViewQuality()).toBe('auto');
    off();
  });
});
