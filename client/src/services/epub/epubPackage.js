import { normalisePath, openZip } from '../../utils/zip';

// An EPUB's package (docs/uploads.md, EPUB reader): the zip, then META-INF/container.xml naming
// the package file (the OPF), whose manifest lists the book's files, whose spine orders its
// chapters, and which says where the contents and the cover are. Everything here is only read:
// documents are parsed by DOMParser, which makes inert documents (no scripts, nothing loaded,
// no external entities or DTDs fetched). What's shown of a chapter goes through sanitize.js.

// Books are small; these only keep a broken or hostile file from taking the device's memory.
export const MAX_ENTRY_BYTES = 50 * 1024 * 1024; // any one file, once inflated
const MAX_ENTRIES = 20_000;
export const MAX_SPINE = 5_000; // chapters
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024; // container.xml, the OPF, the contents

const OPS_NS = 'http://www.idpf.org/2007/ops';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export class EpubError extends Error {}

// Parses XML, or null when it isn't well-formed.
export function parseXml(text, type = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, type);
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

// A chapter (or any of the book's pages) as a document: XHTML as it should be, else read as HTML
// (books' XHTML often isn't well-formed).
export function parseDocument(text) {
  return parseXml(text, 'application/xhtml+xml') ?? new DOMParser().parseFromString(text, 'text/html');
}

// An address another site's (a scheme, or "//host"), not a file of the book's.
export function isExternal(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

// `href` (as a page of the book at `from` wrote it) -> { path, fragment } inside the book, or
// null for another site's address.
export function resolveHref(from, href) {
  const raw = String(href ?? '').trim();
  if (isExternal(raw)) return null;
  const hash = raw.indexOf('#');
  const fragment = hash >= 0 ? safeDecode(raw.slice(hash + 1)) : '';
  const target = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/\?.*$/, '');
  if (!target) return { path: from, fragment };
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  return { path: normalisePath(target.startsWith('/') ? target : dir + target), fragment };
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const byLocalName = (root, name) => [...root.getElementsByTagNameNS('*', name)];
const firstText = (root, name) => byLocalName(root, name)[0]?.textContent.trim() || null;

// Opens `blob` as an EPUB: { title, author, manifest (Map id -> { id, path, type, properties }),
// spine ([{ id, path }]), navPath, ncxPath, coverId, entry(path), text(path, max) }. Throws
// EpubError when it isn't one.
export async function openEpubPackage(blob) {
  let zip;
  try {
    zip = await openZip(blob, { maxEntryBytes: MAX_ENTRY_BYTES, maxEntries: MAX_ENTRIES });
  } catch (err) {
    throw new EpubError(err.message);
  }
  const lowerCase = new Map([...zip.entries.keys()].map((key) => [key.toLowerCase(), key]));
  const entry = (path) => zip.entries.get(path) ?? zip.entries.get(lowerCase.get(String(path).toLowerCase())) ?? null;
  const text = async (path, max = MAX_PACKAGE_BYTES) => {
    const found = entry(path);
    if (!found) return null;
    if (found.size > max) throw new EpubError(`${path} too big`);
    return (await found.blob()).text();
  };

  const container = parseXml(await text('META-INF/container.xml') ?? '');
  const opfPath = container && byLocalName(container, 'rootfile')
    .find((el) => el.getAttribute('full-path'))?.getAttribute('full-path');
  if (!opfPath) throw new EpubError('no package file');
  const packagePath = normalisePath(opfPath);
  const opf = parseXml(await text(packagePath) ?? '');
  if (!opf) throw new EpubError('bad package file');

  const manifest = new Map();
  for (const item of byLocalName(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const resolved = href ? resolveHref(packagePath, href) : null;
    if (!id || !resolved) continue;
    manifest.set(id, {
      id,
      path: resolved.path,
      type: (item.getAttribute('media-type') || '').toLowerCase(),
      properties: new Set((item.getAttribute('properties') || '').split(/\s+/).filter(Boolean)),
    });
  }
  const spineEl = byLocalName(opf, 'spine')[0];
  const spine = byLocalName(opf, 'itemref')
    .map((ref) => manifest.get(ref.getAttribute('idref')))
    .filter((item) => item && entry(item.path))
    .map(({ id, path }) => ({ id, path }));
  if (spine.length > MAX_SPINE) throw new EpubError('too many chapters');

  const items = [...manifest.values()];
  const nav = items.find((item) => item.properties.has('nav'));
  const ncx = manifest.get(spineEl?.getAttribute('toc')) ?? items.find((item) => item.type === 'application/x-dtbncx+xml');
  const coverMeta = byLocalName(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const cover = items.find((item) => item.properties.has('cover-image'))
    ?? manifest.get(coverMeta)
    // Some books name the cover's file rather than its id.
    ?? items.find((item) => coverMeta && item.path.endsWith(coverMeta));

  return {
    title: firstText(opf, 'title'),
    author: firstText(opf, 'creator'),
    manifest,
    spine,
    navPath: nav?.path ?? null,
    ncxPath: ncx?.path ?? null,
    coverPath: cover?.path ?? null,
    entry,
    text,
  };
}

// The cover's path in the book, or null: the manifest's cover image (EPUB 3), the item its
// `<meta name="cover">` names (EPUB 2), else the first picture on a first page called a cover.
export async function findCoverPath(book) {
  if (book.coverPath && book.entry(book.coverPath)) return book.coverPath;
  const first = book.spine[0];
  if (!first || !/cover/i.test(`${first.id} ${first.path}`)) return null;
  const doc = parseDocument(await book.text(first.path) ?? '');
  for (const el of [...byLocalName(doc, 'img'), ...byLocalName(doc, 'image')]) {
    const href = el.getAttribute('src') ?? el.getAttributeNS(XLINK_NS, 'href') ?? el.getAttribute('href');
    const resolved = href ? resolveHref(first.path, href) : null;
    if (resolved && book.entry(resolved.path)) return resolved.path;
  }
  return null;
}

// The book's contents as [{ label, path, fragment, children }], from its EPUB 3 contents page
// (the `nav` marked as the toc) or its EPUB 2 NCX; [] when it has neither.
export async function readContents(book) {
  const MAX_ITEMS = 5_000;
  let count = 0;
  if (book.navPath) {
    const doc = parseDocument(await book.text(book.navPath) ?? '');
    const navs = byLocalName(doc, 'nav');
    const nav = navs.find((el) => (el.getAttributeNS(OPS_NS, 'type') ?? el.getAttribute('epub:type') ?? '').split(/\s+/).includes('toc')) ?? navs[0];
    const list = nav && [...nav.children].find((el) => el.localName === 'ol');
    const read = (ol) => [...ol.children].filter((li) => li.localName === 'li').flatMap((li) => {
      if (++count > MAX_ITEMS) return [];
      const label = [...li.children].find((el) => el.localName === 'a' || el.localName === 'span');
      const sub = [...li.children].find((el) => el.localName === 'ol');
      const resolved = label?.getAttribute('href') ? resolveHref(book.navPath, label.getAttribute('href')) : null;
      return [{
        label: label?.textContent.replace(/\s+/g, ' ').trim() || '',
        path: resolved?.path ?? null,
        fragment: resolved?.fragment ?? '',
        children: sub ? read(sub) : [],
      }];
    });
    if (list) return read(list);
  }
  if (book.ncxPath) {
    const doc = parseXml(await book.text(book.ncxPath) ?? '');
    const map = doc && byLocalName(doc, 'navMap')[0];
    const read = (parent) => [...parent.children].filter((el) => el.localName === 'navPoint').flatMap((point) => {
      if (++count > MAX_ITEMS) return [];
      const labelEl = [...point.children].find((el) => el.localName === 'navLabel');
      const content = [...point.children].find((el) => el.localName === 'content');
      const resolved = content?.getAttribute('src') ? resolveHref(book.ncxPath, content.getAttribute('src')) : null;
      return [{
        label: labelEl?.textContent.replace(/\s+/g, ' ').trim() || '',
        path: resolved?.path ?? null,
        fragment: resolved?.fragment ?? '',
        children: read(point),
      }];
    });
    if (map) return read(map);
  }
  return [];
}
