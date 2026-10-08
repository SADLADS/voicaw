// The cropper's maths (components/ImageCropper.jsx). Everything is in fractions of the square
// frame: a view is { zoom, x, y }, where x and y place the picture's top-left corner (0, 0 is
// the frame's top-left; negative is further up and left). At zoom 1 the picture's shorter side
// just fills the frame; it can never leave a gap in it.

export const MAX_ZOOM = 5;

// The picture's size in frame widths at this zoom, for a width×height picture.
function sizeAt(zoom, width, height) {
  const scale = zoom / Math.min(width, height);
  return { w: width * scale, h: height * scale };
}

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

// Keeps the zoom in range and the frame covered.
export function clampView(view, width, height) {
  const zoom = clampNumber(view.zoom, 1, MAX_ZOOM);
  const { w, h } = sizeAt(zoom, width, height);
  return { zoom, x: clampNumber(view.x, 1 - w, 0), y: clampNumber(view.y, 1 - h, 0) };
}

// Zoom 1, centred.
export function initialView(width, height) {
  const { w, h } = sizeAt(1, width, height);
  return { zoom: 1, x: (1 - w) / 2, y: (1 - h) / 2 };
}

// Where to draw the picture over the frame: { left, top, width, height } in frame widths.
export function layout(view, width, height) {
  const { w, h } = sizeAt(view.zoom, width, height);
  return { left: view.x, top: view.y, width: w, height: h };
}

// Moved by (dx, dy) frame widths.
export function panView(view, width, height, dx, dy) {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, width, height);
}

// At a new zoom, keeping the point (px, py) of the frame over the same spot of the picture
// (the frame's middle for the slider, the pointer for a wheel or a pinch).
export function zoomView(view, width, height, zoom, px = 0.5, py = 0.5) {
  const before = sizeAt(view.zoom, width, height);
  const after = sizeAt(clampNumber(zoom, 1, MAX_ZOOM), width, height);
  const u = (px - view.x) / before.w;
  const v = (py - view.y) / before.h;
  return clampView({ zoom, x: px - u * after.w, y: py - v * after.h }, width, height);
}

// What the server cuts out (avatarImage.js parseCrop): { x, y, width, height } as fractions of
// the picture.
export function cropOf(view, width, height) {
  const { w, h } = sizeAt(view.zoom, width, height);
  const fit = (n) => clampNumber(n, 0, 1);
  return { x: fit(-view.x / w), y: fit(-view.y / h), width: fit(1 / w), height: fit(1 / h) };
}
