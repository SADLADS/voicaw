import { describe, it, expect } from 'vitest';
import { clampView, zoomAt } from './useStreamZoom';

// A 16:9 stream letterboxed in a squarer stage: the picture fills the width, not the height.
const stage = { width: 500, height: 470 };
const picture = { width: 500, height: 281.25 };

describe('stream zoom geometry', () => {
  it('keeps the point under the wheel where it is, even while the picture is shorter than the stage', () => {
    // 40 px above the middle; at 1.5× the picture (422 px) is still shorter than the stage.
    const view = zoomAt({ scale: 1, x: 0, y: 0 }, 1.5, 0, -40, stage, picture);
    expect(view).toEqual({ scale: 1.5, x: 0, y: 20 });
    // The point: (py - y) / scale from the picture's centre, the same before and after.
    expect((-40 - view.y) / view.scale).toBe(-40);
  });

  it('keeps a short side inside the stage and a long one covering it', () => {
    expect(clampView({ scale: 1.5, x: 0, y: 500 }, stage, picture).y).toBe((470 - 421.875) / 2);
    expect(clampView({ scale: 3, x: -5000, y: 0 }, stage, picture).x).toBe(-(1500 - 500) / 2);
  });

  it('is centred at 100% and stops at 800%', () => {
    expect(zoomAt({ scale: 1.2, x: 0, y: 20 }, 0.5, 0, 0, stage, picture)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(zoomAt({ scale: 4, x: 0, y: 0 }, 20, 0, 0, stage, picture).scale).toBe(8);
  });
});
