// Reads an image or video file's pixel size so its space in the chat can be reserved
// before it has downloaded. Resolves to { width, height } or null if unknown; for a video
// also its `duration` (s) and `poster`, a JPEG Blob of its first frame (or null), so others
// see what it is without downloading any of the video itself.
export async function readMediaDimensions(file, objectUrl) {
  try {
    if (file.type.startsWith('image/')) {
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(file); // applies EXIF orientation, like <img>
        const dims = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return valid(dims);
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
