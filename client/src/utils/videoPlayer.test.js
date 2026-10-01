import { describe, it, expect } from 'vitest';
import { formatDuration, bufferedSpans } from './videoPlayer';

describe('videoPlayer', () => {
  it('formats durations like players do', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9.9)).toBe('0:09');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(NaN)).toBe('0:00');
  });

  it("turns a media element's buffered ranges into fractions", () => {
    const ranges = [[0, 10], [50, 120]];
    const buffered = { length: 2, start: (i) => ranges[i][0], end: (i) => ranges[i][1] };
    expect(bufferedSpans(buffered, 100)).toEqual([[0, 0.1], [0.5, 1]]);
    expect(bufferedSpans(buffered, NaN)).toEqual([]);
  });
});
