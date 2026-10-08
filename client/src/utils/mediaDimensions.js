import { MAX_MEDIA_WIDTH, MAX_MEDIA_HEIGHT } from './mediaBox';

// Images bigger than this aren't decoded when attached, and without a thumbnail are shown as a
// file to download rather than in the chat (Attachment.jsx).
export const MAX_INLINE_IMAGE_BYTES = 50 * 1024 * 1024;

// Reads an image or video file's pixel size so its space in the chat can be reserved
// before it has downloaded. Resolves to { width, height } or null if unknown; for a video
// also its `duration` (s) and `poster`, a JPEG Blob of its first frame (or null), so others
// see what it is without downloading any of the video itself. A big still image also gets a
// `thumbnail` (a Blob, see makeThumbnail), shown in the chat in its place; the file itself is
// sent exactly as it is.
export async function readMediaDimensions(file, objectUrl) {
  try {
    if (file.type.startsWith('image/')) {
      // Decoding it would take more memory than a phone has; it's sent as a plain file.
      if (file.size > MAX_INLINE_IMAGE_BYTES) return null;
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(file); // applies EXIF orientation, like <img>
        try {
          const dims = valid({ width: bitmap.width, height: bitmap.height });
          if (!dims) return null;
          const thumbnail = await makeThumbnail(file, bitmap).catch(() => null);
          return thumbnail ? { ...dims, thumbnail } : dims;
        } finally {
          bitmap.close();
        }
      }
      return valid(await loadElement(new Image(), objectUrl, 'load', (img) => ({
        width: img.naturalWidth,
        height: img.naturalHeight,
      })));
    }
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      const dims = valid(await loadElement(video, objectUrl, 'loadedmetadata', (v) => ({
        width: v.videoWidth,
        height: v.videoHeight,
      })));
      if (!dims) return null;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      const poster = await capturePoster(video).catch(() => null);
      video.removeAttribute('src');
      video.load();
      return { ...dims, duration, poster };
    }
  } catch {
    // Unsupported or corrupt media: the attachment just won't have a reserved size.
  }
  return null;
}

// Longest side of a poster: sharp at the chat's size (420×360) on a high-density screen.
const POSTER_MAX = 720;

// The first frame of a loaded <video>, as a JPEG. Safari (iPhones especially) often won't
// decode a frame of a video nobody has played: seeking to the first instant usually makes it,
// and failing that a muted play and pause does.
function capturePoster(video) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timers = [];
    const events = ['loadeddata', 'seeked', 'playing'];
    const finish = () => {
      done = true;
      timers.forEach(clearTimeout);
      events.forEach((name) => video.removeEventListener(name, draw));
    };
    function draw() {
      if (done || video.readyState < 2) return;
      finish();
      video.pause();
      const scale = Math.min(1, POSTER_MAX / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no poster'))), 'image/jpeg', 0.8);
    }
    events.forEach((name) => video.addEventListener(name, draw));
    timers.push(setTimeout(() => {
      finish();
      reject(new Error('timed out'));
    }, 8000));
    if (video.readyState >= 2) {
      draw();
      return;
    }
    video.currentTime = 0.001;
    timers.push(setTimeout(() => {
      if (!done) Promise.resolve(video.play()).catch(() => {});
    }, 1500));
  });
}

// Thumbnails fit a box twice the chat's (420×360), so they're sharp on a high-density screen.
const THUMBNAIL_MAX_WIDTH = MAX_MEDIA_WIDTH * 2;
const THUMBNAIL_MAX_HEIGHT = MAX_MEDIA_HEIGHT * 2;
// Below this share of the file's size, a thumbnail isn't worth a second download.
const THUMBNAIL_MAX_SHARE = 0.75;
// Still formats a canvas draws faithfully. GIFs, animated PNGs and WebPs would lose their
// animation (a canvas has only the first frame), SVGs their sharpness; anything else is left
// as it is.
const THUMBNAIL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp']);

// A smaller copy of a decoded image (`bitmap`, already turned the way its EXIF says) for the
// chat: a JPEG, or a WebP (PNG where the browser can't make WebPs) when it has transparency.
// Being redrawn, it carries no EXIF (no location, no camera). Resolves to null when the image
// is small enough as it is, might be animated, or the copy wouldn't save much.
export async function makeThumbnail(file, bitmap) {
  if (!THUMBNAIL_TYPES.has(file.type) || typeof document === 'undefined') return null;
  const scale = Math.min(THUMBNAIL_MAX_WIDTH / bitmap.width, THUMBNAIL_MAX_HEIGHT / bitmap.height);
  if (scale >= 1) return null;
  if (await mayBeAnimated(file)) return null;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const transparent = file.type !== 'image/jpeg' && file.type !== 'image/bmp' && hasTransparency(context, canvas);
  const blob = await new Promise((resolve) => {
    if (transparent) canvas.toBlob(resolve, 'image/webp', 0.85);
    else canvas.toBlob(resolve, 'image/jpeg', 0.85);
  });
  return blob && blob.size < file.size * THUMBNAIL_MAX_SHARE ? blob : null;
}

function hasTransparency(context, canvas) {
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

// How much of a file is read to tell whether it's animated.
const HEADER_BYTES = 256 * 1024;

// Whether a PNG or WebP might be animated: an APNG has an acTL chunk before its first IDAT, an
// animated WebP the animation flag in its VP8X header. When it can't tell (a PNG whose image
// data starts past the bytes read), it says it might be, so the file is shown as it is.
export async function mayBeAnimated(file) {
  if (file.type !== 'image/png' && file.type !== 'image/webp') return false;
  const bytes = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  const ascii = (at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
  if (file.type === 'image/webp') {
    if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') return true;
    return ascii(12, 4) === 'VP8X' && (bytes[20] & 0x02) !== 0;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length;) {
    const type = ascii(at + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    at += 12 + view.getUint32(at);
  }
  return true;
}

function loadElement(el, src, eventName, read) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 10000);
    el.addEventListener(eventName, () => {
      clearTimeout(timer);
      resolve(read(el));
    }, { once: true });
    el.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('failed to load'));
    }, { once: true });
    el.src = src;
  });
}

function valid(dims) {
  return dims && dims.width > 0 && dims.height > 0 ? dims : null;
}
