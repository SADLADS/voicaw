import { findCoverPath, openEpubPackage } from './epubPackage';
import { rasterType } from './imageType';

// A book's cover, read on the sender's device when the book is attached (useAttachmentDrafts ->
// readMediaDimensions), sent encrypted beside it as its thumbnail (`p=`), so others see the
// cover without downloading the book. Only pixels go: the picture is decoded and redrawn on a
// canvas as a new JPEG, so nothing of the book's own file is passed on, and an SVG cover (which
// could hold script) is no cover at all.

const MAX_COVER_BYTES = 20 * 1024 * 1024;
// About twice the size it's shown at in the chat, for high-density screens.
const COVER_MAX_WIDTH = 280;
const COVER_MAX_HEIGHT = 400;

// -> { width, height, thumbnail (a JPEG Blob) }, or null when the book has no cover we can draw.
export async function readEpubCover(file) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const book = await openEpubPackage(file);
  const path = await findCoverPath(book);
  const entry = path && book.entry(path);
  if (!entry || entry.size > MAX_COVER_BYTES) return null;
  const bytes = await (await entry.blob()).arrayBuffer();
  const type = rasterType(bytes);
  if (!type) return null;
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  try {
    const scale = Math.min(1, COVER_MAX_WIDTH / bitmap.width, COVER_MAX_HEIGHT / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; // a transparent cover's background, as a page's
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return thumbnail ? { width: canvas.width, height: canvas.height, thumbnail } : null;
  } finally {
    bitmap.close?.();
  }
}
