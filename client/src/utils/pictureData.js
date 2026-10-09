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

// `crop` (from ImageCropper) of the picture, sent as a data: URI: { data, crop }, where `crop` is
// what the server still has to cut out (avatarCrop). Pictures are cut here, so a close crop of a
// big photo isn't shrunk to a blur first; GIFs go whole with the crop, to stay animated.
export async function croppedPictureData(file, crop) {
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return { data: await readAsDataUri(file), crop };
  return { data: await drawCrop(file, crop, SHRINK_TO, 'image/webp'), crop: null };
}

// What `crop` of the picture looks like, as a blob URL at most 256 px across (a preview before
// saving; the server makes the real one, animated if the picture is). Revoke it when done.
export async function croppedPreview(file, crop) {
  return URL.createObjectURL(await (await fetch(await drawCrop(file, crop, 256, 'image/png'))).blob());
}

// `crop` of the picture as WebP bytes (a Uint8Array) at most `max` px across: for pictures cut on
// the device because the server never sees them (group DM pictures, which are encrypted). GIFs
// become still.
export async function croppedPictureBytes(file, crop, max = 256) {
  return new Uint8Array(await (await fetch(await drawCrop(file, crop, max, 'image/webp'))).arrayBuffer());
}

// The crop drawn on a canvas at most `max` px across (never enlarged), as a data: URI.
async function drawCrop(file, crop, max, type) {
  const bitmap = await createImageBitmap(file); // upright, as the cropper showed it
  const side = Math.min(crop.width * bitmap.width, crop.height * bitmap.height);
  const size = Math.max(1, Math.round(Math.min(max, side)));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(bitmap, crop.x * bitmap.width, crop.y * bitmap.height, side, side, 0, 0, size, size);
  return canvas.toDataURL(type, 0.9);
}
