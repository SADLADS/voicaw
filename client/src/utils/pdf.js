// PDFs sent as attachments (docs/uploads.md, PDF reader). Kept tiny: PDF.js itself
// (services/pdf/) loads only when a PDF is opened or attached.
export const PDF_TYPE = 'application/pdf';

// Whether a file is a PDF: by its type, or by its name (some systems give files no type, and
// older apps may have sent one as application/octet-stream).
export function isPdf(type, name) {
  return type === PDF_TYPE || /\.pdf$/i.test(String(name ?? ''));
}

// The most pages a PDF is taken to have (services/pdf/pdfjs.js refuses more; an attachment's
// `pg=` above it is ignored).
export const MAX_PDF_PAGES = 10000;
