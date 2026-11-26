// EPUB books sent as attachments (docs/uploads.md, EPUB reader). Kept tiny: the reader itself
// (services/epub/) loads only when a book is opened or attached.
export const EPUB_TYPE = 'application/epub+zip';

// Whether a file is an EPUB: by its type, or by its name (some systems give .epub files no
// type, and older apps sent them as application/octet-stream).
export function isEpub(type, name) {
  return type === EPUB_TYPE || /\.epub$/i.test(String(name ?? ''));
}
