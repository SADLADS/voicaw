// Geometry for the image viewer. A view is { scale, x, y }: the image is drawn at its
// natural size times `scale`, with its centre offset by (x, y) px from the stage's centre.
// `stage` and `image` are { width, height } (the image's natural size).

// Largest zoom, relative to the image's natural size (or to the fitted size, if larger).
export const MAX_ZOOM = 8;
export const ZOOM_STEP = 1.5;

// Scale that shows the whole image. Small images aren't blown up.
export function fitScale(stage, image) {
  if (!image.width || !image.height || !stage.width || !stage.height) return 1;
  return Math.min(1, stage.width / image.width, stage.height / image.height);
}

export function scaleLimits(stage, image) {
  const min = fitScale(stage, image);
  return { min, max: Math.max(MAX_ZOOM, min) };
}

export function fittedView(stage, image) {
  return { scale: fitScale(stage, image), x: 0, y: 0 };
}

export function isZoomed(view, stage, image) {
  return view.scale > fitScale(stage, image) * 1.001;
}

function clampAxis(offset, imageSize, stageSize) {
  // Smaller than the stage: centred. Larger: no gap may open at either edge.
  if (imageSize <= stageSize) return 0;
  const limit = (imageSize - stageSize) / 2;
  return Math.min(limit, Math.max(-limit, offset));
}

export function clampView(view, stage, image) {
  const { min, max } = scaleLimits(stage, image);
  const scale = Math.min(max, Math.max(min, view.scale));
  return {
    scale,
    x: clampAxis(view.x, image.width * scale, stage.width),
    y: clampAxis(view.y, image.height * scale, stage.height),
  };
}

// Zooms to `scale`, keeping the image point under (px, py) (relative to the stage's centre)
// where it is.
export function zoomAt(view, scale, px, py, stage, image) {
  const { min, max } = scaleLimits(stage, image);
  const next = Math.min(max, Math.max(min, scale));
  const ratio = next / view.scale;
  return clampView(
    { scale: next, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio },
    stage,
    image
  );
}

// Double click / double tap: zoom in on the point (to actual size, or twice the fitted
// size for images smaller than the screen), or back out to fit.
export function toggleZoomAt(view, px, py, stage, image) {
  if (isZoomed(view, stage, image)) return fittedView(stage, image);
  const fit = fitScale(stage, image);
  return zoomAt(view, Math.max(1, fit * 2), px, py, stage, image);
}
