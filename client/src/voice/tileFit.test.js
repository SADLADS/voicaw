import { describe, it, expect } from 'vitest';
import { fitTileWidth } from './tileFit';

describe('fitTileWidth', () => {
  it('lets one camera fill the box, up to the height it has', () => {
    expect(fitTileWidth({ width: 1200, height: 900, count: 1 })).toBe(1200);
    expect(fitTileWidth({ width: 1600, height: 450, count: 1 })).toBe(800);
  });

  it('puts two side by side on a wide box and on top of each other on a tall one', () => {
    expect(fitTileWidth({ width: 1412, height: 700, count: 2 })).toBe(700);
    expect(fitTileWidth({ width: 358, height: 600, count: 2 })).toBe(358);
  });

  it('never goes under the smallest size, scrolling instead, nor over the box', () => {
    expect(fitTileWidth({ width: 800, height: 200, count: 30 })).toBe(160);
    expect(fitTileWidth({ width: 120, height: 200, count: 30 })).toBe(120);
  });

  it('copes with a box that has no size yet', () => {
    expect(fitTileWidth({ width: 0, height: 0, count: 2 })).toBe(160);
  });
});
