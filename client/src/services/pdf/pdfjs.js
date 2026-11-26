// The one place Mozilla's PDF.js is set up (PDF reader in docs/uploads.md). A PDF is someone
// else's file, so PDF.js gets only what it needs to draw pages:
// - its worker is our own file (the CSP's script-src 'self'), and nothing else of its loads from
//   another site: the character maps, standard fonts, colour profiles and image decoders are
//   copies in our build (`/pdfjs/`, vite.config.js `pdfjsAssets`);
// - PDF JavaScript never runs: there's no scripting sandbox (`PDFScriptingManager`) anywhere,
//   XFA forms are off (`enableXfa: false`), and PDF.js 6 has no eval-based font path any more
//   (CVE-2024-4367's route; the CSP refuses eval anyway);
// - forms are drawn as they look but can't be filled in (the reader's `annotationMode`), files
//   attached inside a PDF are never opened (no download manager), and the reader's link handling
//   lets only http(s): and mailto: links out (PdfReader.jsx);
// - caps keep a hostile file from filling memory: pictures over MAX_IMAGE_PIXELS aren't decoded,
//   a canvas is at most MAX_CANVAS_BYTES, and a PDF of more than MAX_PDF_PAGES pages is refused.
// The legacy build: the modern one needs JavaScript newer than many phones' (Uint8Array.toHex,
// 2025), and the legacy one is only ~60 KB bigger.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { MAX_PDF_PAGES } from '../../utils/pdf';

// pdf_viewer.mjs (the reader's page layout, PDFViewer) reads the library from here.
globalThis.pdfjsLib = pdfjsLib;
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export const MAX_IMAGE_PIXELS = 50 * 1000 * 1000;
export const MAX_CANVAS_BYTES = 256 * 1024 * 1024;

const ASSETS = `${import.meta.env?.BASE_URL ?? '/'}pdfjs/`;

export { pdfjsLib };

// Thrown when a PDF needs a password nobody gave (`code` 'password').
export class PdfPasswordError extends Error {
  constructor() {
    super('This PDF needs a password');
    this.code = 'password';
  }
}

// Opens a PDF from its bytes (an ArrayBuffer or Uint8Array; PDF.js takes it over). Resolves to
// PDF.js's document; call `loadingTask.destroy()` on it when done. `onPassword(wrong)` (optional)
// is asked for the password, `wrong` when the last one didn't open it; it resolves to the
// password, or null to give up (the promise then rejects with a PdfPasswordError). Without it, a
// PDF with a password is a PdfPasswordError straight away. `assets`: where PDF.js's data files are
// (tests).
export async function openPdf(bytes, { onPassword = null, assets = ASSETS } = {}) {
  const task = pdfjsLib.getDocument({
    data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
    enableXfa: false,
    maxImageSize: MAX_IMAGE_PIXELS,
    canvasMaxAreaInBytes: MAX_CANVAS_BYTES,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
  });
  let gaveUp = false;
  if (onPassword) {
    task.onPassword = (update, reason) => {
      Promise.resolve(onPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD)).then((password) => {
        if (typeof password === 'string' && password) update(password);
        else {
          gaveUp = true;
          task.destroy();
        }
      }, () => {
        gaveUp = true;
        task.destroy();
      });
    };
  }
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    if (gaveUp || err?.name === 'PasswordException') throw new PdfPasswordError();
    throw err;
  }
  if (doc.numPages > MAX_PDF_PAGES) {
    await doc.loadingTask.destroy();
    throw new Error(`Too many pages (${doc.numPages})`);
  }
  return doc;
}
