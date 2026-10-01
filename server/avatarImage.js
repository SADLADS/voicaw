const sharp = require('sharp');

// Turns an uploaded profile picture (up to MAX_AVATAR_UPLOAD_BYTES, any size) into what's
// served: a square AVATAR_SIZE×AVATAR_SIZE WebP, cropped from the middle, never enlarged past
// the original (a small picture stays small and square). Animated GIFs and WebPs stay animated.
// Throws AvatarImageError for anything that isn't a usable image. (Like emojiImage.js.)

const MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024;
const AVATAR_SIZE = 256;
const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_PIXELS = 60 * 1000 * 1000; // all frames together
const MAX_FRAMES = 300;

class AvatarImageError extends Error {}

async function processAvatar(input) {
  let meta;
  try {
    meta = await sharp(input, { animated: true, limitInputPixels: false }).metadata();
  } catch {
    throw new AvatarImageError("That file isn't an image we can read");
  }
  const frames = meta.pages ?? 1;
  const frameHeight = meta.pageHeight ?? meta.height;
  if (!meta.width || !frameHeight) throw new AvatarImageError("That file isn't an image we can read");
  if (frames > MAX_FRAMES) throw new AvatarImageError(`Animated pictures can have at most ${MAX_FRAMES} frames`);
  if (meta.width * frameHeight * frames > MAX_PIXELS) throw new AvatarImageError('That image is too large');
  const animated = frames > 1;
  const side = Math.min(AVATAR_SIZE, meta.width, frameHeight);

  const encode = (quality) => sharp(input, { animated, limitInputPixels: MAX_PIXELS })
    .timeout({ seconds: 20 })
    .rotate() // follow EXIF orientation (photos)
    .resize(side, side, { fit: 'cover', position: 'centre' })
    .webp({ quality, effort: 4, ...(animated ? { loop: meta.loop ?? 0 } : {}) })
    .toBuffer();

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

module.exports = { processAvatar, AvatarImageError, MAX_AVATAR_UPLOAD_BYTES, AVATAR_SIZE };
