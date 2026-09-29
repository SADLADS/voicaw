const sharp = require('sharp');

// Turns an uploaded custom emoji (up to MAX_EMOJI_UPLOAD_BYTES, any size in pixels) into what's
// served: at most 128×128 (like Discord), never enlarged, as WebP. Animated GIFs and WebPs stay
// animated (every frame resized, timing kept). Throws EmojiImageError for anything that isn't
// a usable image.

const MAX_EMOJI_UPLOAD_BYTES = 10 * 1024 * 1024;
const EMOJI_SIZE = 128;
// What a processed emoji may weigh; long animations are squeezed harder, then refused.
const MAX_EMOJI_BYTES = 512 * 1024;
// Decoding limits, so a small file can't expand into something huge.
const MAX_PIXELS = 50 * 1000 * 1000; // all frames together
const MAX_FRAMES = 300;

class EmojiImageError extends Error {}

async function shrinkEmoji(input) {
  let meta;
  try {
    meta = await sharp(input, { animated: true, limitInputPixels: false }).metadata();
  } catch {
    throw new EmojiImageError("That file isn't an image we can read");
  }
  const frames = meta.pages ?? 1;
  const frameHeight = meta.pageHeight ?? meta.height;
  if (!meta.width || !frameHeight) throw new EmojiImageError("That file isn't an image we can read");
  if (frames > MAX_FRAMES) throw new EmojiImageError(`Animated emoji can have at most ${MAX_FRAMES} frames`);
  if (meta.width * frameHeight * frames > MAX_PIXELS) throw new EmojiImageError('That image is too large to use as an emoji');
  const animated = frames > 1;

  const encode = (quality) => sharp(input, { animated, limitInputPixels: MAX_PIXELS })
    .timeout({ seconds: 20 })
    .rotate() // follow EXIF orientation (photos)
    .resize(EMOJI_SIZE, EMOJI_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4, ...(animated ? { loop: meta.loop ?? 0 } : {}) })
    .toBuffer();

  let output;
  try {
    output = await encode(85);
    if (output.length > MAX_EMOJI_BYTES) output = await encode(50);
  } catch {
    throw new EmojiImageError("That image couldn't be processed");
  }
  if (output.length > MAX_EMOJI_BYTES) {
    throw new EmojiImageError('That animation is too long for an emoji, even when shrunk');
  }
  return { buffer: output, animated, contentType: 'image/webp' };
}

module.exports = { shrinkEmoji, EmojiImageError, MAX_EMOJI_UPLOAD_BYTES, EMOJI_SIZE };
