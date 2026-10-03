// Pictures sent as data: URIs (Discord's way, for webhooks and bots), shrunk in the browser
// first so the request stays small (nginx takes 1 MB; the server makes them 256×256 anyway).

// What the server takes before shrinking (avatarImage.js).
export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

const SHRINK_TO = 512;

const readAsDataUri = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

// The picture as a data: URI, at most SHRINK_TO px across. GIFs go as they are, to stay animated.
export async function pictureData(file) {
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return readAsDataUri(file);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, SHRINK_TO / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.9);
}
