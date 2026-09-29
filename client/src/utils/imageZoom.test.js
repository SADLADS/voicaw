import { describe, it, expect } from 'vitest';
import { fitScale, clampView, zoomAt, toggleZoomAt, fittedView, isZoomed, MAX_ZOOM } from './imageZoom';

const stage = { width: 1000, height: 800 };
const photo = { width: 4000, height: 2000 };
const icon = { width: 100, height: 50 };

describe('imageZoom', () => {
  it('fits large images inside the stage and leaves small ones at their size', () => {
    expect(fitScale(stage, photo)).toBe(0.25);
    expect(fitScale(stage, icon)).toBe(1);
  });

  it('keeps the scale between fit and the maximum', () => {
    expect(clampView({ scale: 0.01, x: 0, y: 0 }, stage, photo).scale).toBe(0.25);
    expect(clampView({ scale: 100, x: 0, y: 0 }, stage, photo).scale).toBe(MAX_ZOOM);
  });

  it('centres an axis the image does not fill and stops panning past the edges', () => {
    // At 0.25 the photo is 1000x500: fills the width exactly, not the height.
    expect(clampView({ scale: 0.25, x: 300, y: 200 }, stage, photo)).toEqual({ scale: 0.25, x: 0, y: 0 });
    // At 1 it's 4000x2000: can pan 1500 sideways, 600 up or down.
    expect(clampView({ scale: 1, x: 5000, y: -5000 }, stage, photo)).toEqual({ scale: 1, x: 1500, y: -600 });
  });

  it('keeps the point under the cursor still when zooming', () => {
    const start = { scale: 1, x: 0, y: 0 };
    const px = 200, py = -100;
    // Image point under the cursor before: (px - x) / scale.
    const before = { u: (px - start.x) / start.scale, v: (py - start.y) / start.scale };
    const next = zoomAt(start, 2, px, py, stage, photo);
    expect(next.scale).toBe(2);
    expect((px - next.x) / next.scale).toBeCloseTo(before.u);
    expect((py - next.y) / next.scale).toBeCloseTo(before.v);
  });

  it('double click zooms to actual size, or double the size for small images, and back', () => {
    const zoomed = toggleZoomAt(fittedView(stage, photo), 0, 0, stage, photo);
    expect(zoomed.scale).toBe(1);
    expect(isZoomed(zoomed, stage, photo)).toBe(true);
    expect(toggleZoomAt(zoomed, 0, 0, stage, photo)).toEqual(fittedView(stage, photo));

    expect(toggleZoomAt(fittedView(stage, icon), 0, 0, stage, icon).scale).toBe(2);
  });
});
