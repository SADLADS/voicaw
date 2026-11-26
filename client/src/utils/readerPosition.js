// What names an attachment for remembering where it was left in a reader (the EPUB reader's
// utils/epubPosition.js, the PDF reader's utils/pdfPosition.js): the file's own name in the
// store (`<uuid>.bin`), from its address.
export function positionKeyFor(fileUrl) {
  const name = String(fileUrl ?? '').split('#')[0].split('?')[0].split('/').pop();
  return name || null;
}
