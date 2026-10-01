import { describe, it, expect } from 'vitest';
import { parseRange } from './mediaStreamWorker';

describe('parseRange', () => {
  it("reads the browser's Range headers", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual([0, 99]);
    expect(parseRange('bytes=0-1', 100)).toEqual([0, 1]);
    expect(parseRange('bytes=50-500', 100)).toEqual([50, 99]);
    expect(parseRange('bytes=-10', 100)).toEqual([90, 99]);
  });

  it('refuses what it can\'t serve', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-2', 100)).toBe('invalid');
    expect(parseRange('bytes=-', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });
});
