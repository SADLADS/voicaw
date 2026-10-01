// Reads an image or video file's pixel size so its space in the chat can be reserved
// before it has downloaded. Resolves to { width, height } or null if unknown.
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
      video.preload = 'metadata';
      return valid(await loadElement(video, objectUrl, 'loadedmetadata', (v) => ({
        width: v.videoWidth,
        height: v.videoHeight,
      })));
    }
  } catch {
    // Unsupported or corrupt media: the attachment just won't have a reserved size.
  }
  return null;
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
