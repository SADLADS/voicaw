import { afterEach, describe, expect, it } from 'vitest';
import { cornerFreeFor, cornerHolder, leaveCorner, resetCornerSlot, wantCorner } from './cornerSlot';

afterEach(() => resetCornerSlot());

describe('the corner, one player at a time', () => {
  it('is free until someone wants it, then theirs', () => {
    expect(cornerHolder()).toBeNull();
    expect(cornerFreeFor('video')).toBe(true);
    wantCorner('stream');
    expect(cornerHolder()).toBe('stream');
    expect(cornerFreeFor('stream')).toBe(true);
    expect(cornerFreeFor('video')).toBe(false);
  });

  it('goes to whoever wanted it first, and the next in line gets it once they let go', () => {
    wantCorner('video');
    wantCorner('watchParty');
    wantCorner('stream');
    expect(cornerHolder()).toBe('video');
    leaveCorner('video');
    expect(cornerHolder()).toBe('watchParty');
    leaveCorner('watchParty');
    expect(cornerHolder()).toBe('stream');
    leaveCorner('stream');
    expect(cornerHolder()).toBeNull();
  });

  it("doesn't queue the same player twice, nor move it back in line", () => {
    wantCorner('stream');
    wantCorner('watchParty');
    wantCorner('stream');
    leaveCorner('stream');
    expect(cornerHolder()).toBe('watchParty');
  });
});
