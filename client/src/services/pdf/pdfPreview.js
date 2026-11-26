import { openPdf } from './pdfjs';

// A PDF's first page and its number of pages, worked out on the sender's device when the PDF is
// attached (useAttachmentDrafts -> readMediaDimensions) and sent beside it: the page as the
// attachment's thumbnail (`p=`, encrypted with the file's key), the count as `pg=` in its URL. So
// others see what it is without downloading it. Only pixels go: the page is drawn by PDF.js on a
// canvas and saved as a new JPEG.

// About twice the size it's shown at in the chat, for high-density screens (as a book's cover).
const PREVIEW_MAX_WIDTH = 280;
const PREVIEW_MAX_HEIGHT = 400;

// Draws `page` (PDF.js's) on a new canvas the size of `viewport`, on white (a page's own background is
// transparent), and resolves to a JPEG Blob or null.
async function drawPage(page, viewport) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport, background: '#fff' }).promise;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return blob ? { blob, width: canvas.width, height: canvas.height } : null;
}

// -> { pages, width, height, thumbnail (a JPEG Blob) }, { pages } when the first page couldn't be
// drawn, or null when the file can't be opened (broken, not a PDF, or needing a password: then
// nothing at all is said about it). `draw` and `options` are for tests.
export async function readPdfPreview(file, { draw = drawPage, ...options } = {}) {
  let doc;
  try {
    doc = await openPdf(await file.arrayBuffer(), options);
  } catch {
    return null;
  }
  try {
    const pages = doc.numPages;
    try {
      const page = await doc.getPage(1);
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(PREVIEW_MAX_WIDTH / natural.width, PREVIEW_MAX_HEIGHT / natural.height);
      const drawn = Number.isFinite(scale) && scale > 0 ? await draw(page, page.getViewport({ scale })) : null;
      page.cleanup();
      return drawn ? { pages, width: drawn.width, height: drawn.height, thumbnail: drawn.blob } : { pages };
    } catch {
      return { pages };
    }
  } finally {
    await doc.loadingTask.destroy().catch(() => {});
  }
}
