import { describe, it, expect } from 'vitest';
import { MAX_ZOOM, clampView, cropOf, initialView, layout, panView, zoomView } from './imageCrop';

const close = (actual, expected) => {
  for (const key of Object.keys(expected)) expect(actual[key]).toBeCloseTo(expected[key], 6);
};

describe('imageCrop', () => {
  it('starts with the middle square of the picture filling the frame', () => {
    const view = initialView(400, 200);
    close(view, { zoom: 1, x: -0.5, y: 0 });
    close(layout(view, 400, 200), { left: -0.5, top: 0, width: 2, height: 1 });
    close(cropOf(view, 400, 200), { x: 0.25, y: 0, width: 0.5, height: 1 });
    close(cropOf(initialView(100, 300), 100, 300), { x: 0, y: 1 / 3, width: 1, height: 1 / 3 });
  });

  it('never leaves a gap in the frame, nor zooms out past filling it', () => {
    close(panView(initialView(400, 200), 400, 200, 5, 5), { x: 0, y: 0 });
    close(panView(initialView(400, 200), 400, 200, -5, -5), { x: -1, y: 0 });
    close(clampView({ zoom: 0.2, x: 0, y: 0 }, 200, 200), { zoom: 1 });
    close(clampView({ zoom: 50, x: 0, y: 0 }, 200, 200), { zoom: MAX_ZOOM });
  });

  it('zooms around a point, keeping it over the same spot of the picture', () => {
    const square = initialView(100, 100);
    // Around the middle: the middle stays the middle.
    close(cropOf(zoomView(square, 100, 100, 2), 100, 100), { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    // Around the top-left corner: it stays there.
    close(cropOf(zoomView(square, 100, 100, 4, 0, 0), 100, 100), { x: 0, y: 0, width: 0.25, height: 0.25 });
    // Zooming back out can't leave a gap: it's pulled back into place.
    const moved = panView(zoomView(square, 100, 100, 2), 100, 100, -1, -1);
    close(zoomView(moved, 100, 100, 1), { zoom: 1, x: 0, y: 0 });
  });
});
