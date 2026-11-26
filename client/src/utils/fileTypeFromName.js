import { EPUB_TYPE, isEpub } from './epub';
import { PDF_TYPE, isPdf } from './pdf';

// The type of a file the system gave none: books and PDFs by their names (their readers need
// it), anything else a plain file.
export function typeFromName(name) {
  if (isEpub('', name)) return EPUB_TYPE;
  if (isPdf('', name)) return PDF_TYPE;
  return 'application/octet-stream';
}
