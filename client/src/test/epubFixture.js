import { zip } from './zipFixture.js';

// For tests: the smallest PNG (1×1), as bytes.
export const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));

export const xhtml = (body, head = '') => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title>${head}</head><body>${body}</body></html>`;

// For tests: an EPUB of `files` (path under OEBPS/ -> content), its manifest listing each (ids
// a, b, c... in order unless `ids` says), spine `spine` (ids), `manifestExtra` and `metadata`
// added to the package file as given.
export function epub({ files, spine, ids = {}, properties = {}, metadata = '', toc = null, name = 'book.epub' }) {
  const paths = Object.keys(files);
  const idOf = (path, i) => ids[path] ?? String.fromCharCode(97 + i);
  const type = (path) => (/\.x?html$/.test(path) ? 'application/xhtml+xml'
    : /\.ncx$/.test(path) ? 'application/x-dtbncx+xml'
      : /\.css$/.test(path) ? 'text/css'
        : /\.svg$/.test(path) ? 'image/svg+xml' : 'image/png');
  const manifest = paths.map((path, i) => `<item id="${idOf(path, i)}" href="${path}" media-type="${type(path)}"${properties[path] ? ` properties="${properties[path]}"` : ''}/>`).join('');
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Book</dc:title><dc:creator>A. Writer</dc:creator>${metadata}</metadata>
<manifest>${manifest}</manifest><spine${toc ? ` toc="${toc}"` : ''}>${spine.map((id) => `<itemref idref="${id}"/>`).join('')}</spine></package>`;
  return zip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/content.opf': opf,
    ...Object.fromEntries(paths.map((path) => [`OEBPS/${path}`, files[path]])),
  }, name);
}
