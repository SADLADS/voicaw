import { describe, expect, it } from 'vitest';
import { SIDEBAR_WIDTH, clampSidebarWidth, parseSidebarWidth } from './sidebarWidth';

describe('sidebar width', () => {
  it('keeps to the limits', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_WIDTH.min);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_WIDTH.max);
    expect(clampSidebarWidth(301.6)).toBe(302);
  });

  it('leaves room for the page in a narrow window', () => {
    expect(clampSidebarWidth(400, 800)).toBe(800 - 72 - 360);
    // Never below the minimum, even when the window is tiny.
    expect(clampSidebarWidth(400, 300)).toBe(SIDEBAR_WIDTH.min);
  });

  it('reads what was stored, or the default', () => {
    expect(parseSidebarWidth('320')).toBe(320);
    expect(parseSidebarWidth(null)).toBe(SIDEBAR_WIDTH.default);
    expect(parseSidebarWidth('')).toBe(SIDEBAR_WIDTH.default);
    expect(parseSidebarWidth('wide')).toBe(SIDEBAR_WIDTH.default);
    expect(parseSidebarWidth('5000')).toBe(SIDEBAR_WIDTH.max);
  });
});
