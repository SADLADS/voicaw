const sharp = require('sharp');

// Turns an uploaded profile picture (up to MAX_AVATAR_UPLOAD_BYTES, any size) into what's
// served: a square AVATAR_SIZE×AVATAR_SIZE WebP, cut from the square the uploader chose in the
// app's cropper (`crop`, see parseCrop) or from the middle, never enlarged past the original (a
// small picture stays small and square). Animated GIFs and WebPs stay animated. Throws
// AvatarImageError for anything that isn't a usable image. (Like emojiImage.js.) Also used for
// bots' pictures and guild icons.

const MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024;
const AVATAR_SIZE = 256;
const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_PIXELS = 60 * 1000 * 1000; // all frames together
const MAX_FRAMES = 300;

class AvatarImageError extends Error {}

// The part of the picture to keep, as the cropper sends it: { x, y, width, height }, fractions
// of the picture as shown (after its EXIF rotation). Returns null when there's none (the
// middle square), the crop, or throws AvatarImageError when it's malformed.
function parseCrop(crop) {
  if (crop === undefined || crop === null) return null;
  const ok = crop && typeof crop === 'object'
    && ['x', 'y', 'width', 'height'].every((k) => typeof crop[k] === 'number' && Number.isFinite(crop[k]))
    && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
    && crop.x + crop.width <= 1.0001 && crop.y + crop.height <= 1.0001;
  if (!ok) throw new AvatarImageError('Invalid crop');
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}

// The crop in pixels of a width×height picture: a square inside it.
function cropRect(crop, width, height) {
  const left = Math.min(width - 1, Math.floor(crop.x * width));
  const top = Math.min(height - 1, Math.floor(crop.y * height));
  const side = Math.max(1, Math.min(
    Math.round(crop.width * width), Math.round(crop.height * height), width - left, height - top,
  ));
  return { left, top, width: side, height: side };
}

async function processAvatar(input, crop = null) {
  let meta;
  try {
    meta = await sharp(input, { animated: true, limitInputPixels: false }).metadata();
  } catch {
    throw new AvatarImageError("That file isn't an image we can read");
  }
  const frames = meta.pages ?? 1;
  // As shown: after the EXIF rotation (photos; animations have none) and one frame high.
  const width = meta.autoOrient?.width ?? meta.width;
  const frameHeight = frames > 1 ? meta.pageHeight : (meta.autoOrient?.height ?? meta.height);
  if (!width || !frameHeight) throw new AvatarImageError("That file isn't an image we can read");
  if (frames > MAX_FRAMES) throw new AvatarImageError(`Animated pictures can have at most ${MAX_FRAMES} frames`);
  if (width * frameHeight * frames > MAX_PIXELS) throw new AvatarImageError('That image is too large');
  const animated = frames > 1;
  const rect = crop && cropRect(crop, width, frameHeight);
  const side = Math.min(AVATAR_SIZE, rect ? rect.width : Math.min(width, frameHeight));

  const encode = (quality) => {
    let image = sharp(input, { animated, limitInputPixels: MAX_PIXELS })
      .timeout({ seconds: 20 })
      .autoOrient(); // follow EXIF orientation (photos); the crop is of the picture as shown
    if (rect) image = image.extract(rect);
    return image
      .resize(side, side, { fit: 'cover', position: 'centre' })
      .webp({ quality, effort: 4, ...(animated ? { loop: meta.loop ?? 0 } : {}) })
      .toBuffer();
  };

  let output;
  try {
    output = await encode(85);
    if (output.length > MAX_AVATAR_BYTES) output = await encode(50);
  } catch {
    throw new AvatarImageError("That image couldn't be processed");
  }
  if (output.length > MAX_AVATAR_BYTES) throw new AvatarImageError('That animation is too long, even when shrunk');
  return { buffer: output, animated, contentType: 'image/webp' };
}

module.exports = { processAvatar, parseCrop, AvatarImageError, MAX_AVATAR_UPLOAD_BYTES, AVATAR_SIZE };
