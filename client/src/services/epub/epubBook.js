import { EpubError, openEpubPackage, parseDocument, readContents, resolveHref } from './epubPackage';
import { rasterType } from './imageType';
import { sanitizeChapter, sanitizeCss, sanitizeSvgFile } from './sanitize';

// A book as the reader (EpubReader) shows it: its chapters one at a time, each sanitised
// (sanitize.js) with its pictures as blob URLs made from the book's own files, released when
// the book is closed. See EPUB reader in docs/uploads.md.

const MAX_CHAPTER_BYTES = 10 * 1024 * 1024;
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024;
const MAX_SVG_BYTES = 5 * 1024 * 1024;

// Opens `blob` (the decrypted attachment) -> { title, author, chapterCount, contents
// ([{ label, index, fragment, children }], index -1 when it isn't a chapter), chapter(i), close() }.
export async function openBook(blob) {
  const pkg = await openEpubPackage(blob);
  if (!pkg.spine.length) throw new EpubError('no chapters');
  const chapterIndex = new Map();
  pkg.spine.forEach(({ path }, i) => { if (!chapterIndex.has(path)) chapterIndex.set(path, i); });
  const indexOf = (path) => chapterIndex.get(path) ?? -1;

  let closed = false;
  const pictures = new Map(); // path -> Promise<blob URL | null>
  const svgTexts = new Map(); // path -> Promise<string | null>
  const stylesheets = new Map(); // path -> Promise<string>

  const resource = (path) => {
    if (!pictures.has(path)) {
      pictures.set(path, (async () => {
        const entry = pkg.entry(path);
        if (!entry) return null;
        const bytes = new Uint8Array(await (await entry.blob()).arrayBuffer());
        const type = rasterType(bytes);
        return type && !closed ? URL.createObjectURL(new Blob([bytes], { type })) : null;
      })().catch(() => null));
    }
    return pictures.get(path);
  };

  const svg = async (path) => {
    if (!svgTexts.has(path)) {
      svgTexts.set(path, pkg.text(path, MAX_SVG_BYTES).catch(() => null));
    }
    const text = await svgTexts.get(path);
    if (!text || !/<svg[\s>]/i.test(text)) return null;
    return sanitizeSvgFile(text, { path, chapterIndex: indexOf, resource, svg: async () => null });
  };

  const stylesheet = (path) => {
    if (!stylesheets.has(path)) {
      stylesheets.set(path, pkg.text(path, MAX_STYLESHEET_BYTES)
        .then((text) => (text ? sanitizeCss(text, path, resource) : ''))
        .catch(() => ''));
    }
    return stylesheets.get(path);
  };

  const label = (items) => items.map((item) => ({
    label: item.label,
    index: item.path ? indexOf(item.path) : -1,
    fragment: item.fragment,
    children: label(item.children),
  }));
  const contents = label(await readContents(pkg).catch(() => []));

  // -> { index, styles (CSS texts, in order), fragment (a DocumentFragment), bodyClass }.
  async function chapter(index) {
    const { path } = pkg.spine[index];
    const text = await pkg.text(path, MAX_CHAPTER_BYTES);
    const doc = parseDocument(text ?? '');
    const styles = [];
    const head = doc.head ?? doc.getElementsByTagNameNS('*', 'head')[0];
    for (const el of head ? [...head.children] : []) {
      if (el.localName === 'link' && /(^|\s)stylesheet(\s|$)/i.test(el.getAttribute('rel') ?? '')) {
        const resolved = resolveHref(path, el.getAttribute('href') ?? '');
        if (resolved && resolved.path !== path) styles.push(stylesheet(resolved.path));
      } else if (el.localName === 'style') {
        styles.push(sanitizeCss(el.textContent, path, resource));
      }
    }
    const body = doc.body ?? doc.getElementsByTagNameNS('*', 'body')[0] ?? doc.documentElement;
    const markup = doc.contentType === 'text/html'
      ? body.innerHTML
      : [...body.childNodes].map((node) => new XMLSerializer().serializeToString(node)).join('');
    const fragment = await sanitizeChapter(markup, { path, chapterIndex: indexOf, resource, svg });
    return {
      index,
      styles: await Promise.all(styles),
      fragment,
      bodyClass: (body.getAttribute?.('class') ?? '').replace(/[^\w\s-]/g, ''),
    };
  }

  function close() {
    closed = true;
    for (const url of pictures.values()) url.then((u) => u && URL.revokeObjectURL(u));
    pictures.clear();
  }

  return {
    title: pkg.title,
    author: pkg.author,
    chapterCount: pkg.spine.length,
    contents,
    chapter,
    close,
  };
}
