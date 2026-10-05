// Must match the .attachment-media max-width/max-height in dms.css.
export const MAX_MEDIA_WIDTH = 420;
export const MAX_MEDIA_HEIGHT = 360;

// When the media's size is known, give it (and its loading placeholder) its final box up
// front, so the message doesn't change height when the file arrives.
export function reservedBoxStyle(width, height) {
  if (!width || !height) return undefined;
  const scale = Math.min(1, MAX_MEDIA_WIDTH / width, MAX_MEDIA_HEIGHT / height);
  return { width: `${Math.round(width * scale)}px`, height: 'auto', aspectRatio: `${width} / ${height}` };
}

// The same for a video, which always needs a box (its player draws over it): 16:9 until
// its size is known.
export function mediaBoxStyle(width, height) {
  // (Full width: reservedBoxStyle never scales up, so 16×9 itself would be a 16 px box.)
  return reservedBoxStyle(width, height) ?? reservedBoxStyle(MAX_MEDIA_WIDTH, (MAX_MEDIA_WIDTH * 9) / 16);
}
