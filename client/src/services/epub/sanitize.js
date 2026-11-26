import createDOMPurify from 'dompurify';
import { isExternal, resolveHref } from './epubPackage';

// What of a book's pages may reach the app (docs/uploads.md, EPUB reader). A book is someone
// else's HTML: it may hold scripts, event handlers, forms, frames, and addresses of other sites
// that would learn who opened it and when. So:
// - markup goes through DOMPurify (scripts, handlers, frames, forms, media and the like
//   removed), returned as nodes (never turned back into HTML and parsed again), shown in a
//   shadow root (EpubReader) and never as a page of its own;
// - every address left is then rewritten here: a file of the book becomes a blob URL of its
//   bytes typed by what they really are (PNG, JPEG, GIF or WebP only, imageType.js), an SVG
//   picture is sanitised and put inline (a blob typed as SVG would be a page of the app's
//   own if opened), a link to another chapter jumps there, a link to another site stays a link
//   that opens in the browser, and anything else is removed, so nothing is ever fetched from
//   another site;
// - CSS likewise: every url() is resolved inside the book or removed, @import and @font-face
//   dropped, and anything else that could fetch (image-set(), src()...) made invalid.
// The app's Content-Security-Policy, which runs no inline script or handler, is the second line.

let purifier = null;
function purify() {
  if (!purifier) {
    purifier = createDOMPurify(window);
    // Defence in depth: whatever DOMPurify keeps, no attribute starting "on" survives.
    purifier.addHook('uponSanitizeAttribute', (_node, data) => {
      if (/^on/i.test(data.attrName)) data.keepAttr = false;
    });
  }
  return purifier;
}

const FORBID_TAGS = [
  'script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output',
  'base', 'meta', 'link', 'video', 'audio', 'source', 'track', 'dialog',
  'foreignObject', 'foreignobject', 'animate', 'animateMotion', 'animatemotion', 'animateTransform',
  'animatetransform', 'animateColor', 'animatecolor', 'set', 'handler', 'listener',
];
// URL-bearing and behaviour attributes the rewrite below doesn't handle: removed.
const FORBID_ATTR = [
  'srcset', 'ping', 'action', 'formaction', 'background', 'poster', 'lowsrc', 'dynsrc', 'longdesc',
  'usemap', 'manifest', 'codebase', 'archive', 'data', 'autofocus', 'contenteditable', 'draggable',
  'popover', 'popovertarget', 'is', 'slot', 'part', 'exportparts', 'srcdoc', 'download',
];

const BASE_CONFIG = {
  RETURN_DOM_FRAGMENT: true,
  FORCE_BODY: true, // a leading <style> stays in the body rather than being dropped
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_TAGS,
  FORBID_ATTR,
};
const HTML_CONFIG = { ...BASE_CONFIG, USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true } };
const SVG_CONFIG = { ...BASE_CONFIG, USE_PROFILES: { svg: true, svgFilters: true } };

// ---- CSS ----

// CSS escapes written out (`\75 rl(` is `url(`), so what's checked below is what a browser
// would read. Strings may lose their escaped quotes; that only breaks the book's own styling.
function unescapeCss(text) {
  return String(text)
    .replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/g, (_m, hex, newline, char) => {
      if (hex) {
        const code = parseInt(hex, 16);
        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code);
      }
      return newline ? '' : char;
    })
    .replace(/\\/g, '') // one left at the very end
    .replace(/\0/g, '�');
}

const URL_TOKEN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;
// Functions that fetch from a string or a url() written in a way the pattern above doesn't
// take: made invalid, so the browser drops the declaration.
const FETCHING_FUNCTION = /(^|[^a-z0-9_-])((?:-[a-z]+-)?(?:url|image-set|image|cross-fade|src|element|paint|expression))\(/gi;

// The book's CSS (a stylesheet, a <style>, or a style attribute's declarations), from a file at
// `basePath`, with its pictures resolved by `resource(path)` (-> a blob URL or null).
export async function sanitizeCss(text, basePath, resource) {
  let css = unescapeCss(text).replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
  // No other files (@import), no fonts (a shadow root doesn't use them anyway).
  css = css.replace(/@(import|font-face|namespace)\b/gi, '@x-blocked-$1');
  css = css.replace(/(^|[^a-z0-9_-])(behavior|-moz-binding)\s*:/gi, '$1x-blocked:');

  const found = [...css.matchAll(URL_TOKEN)];
  const urls = await Promise.all(found.map(async (match) => {
    const href = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (href.startsWith('#')) return `url("#${cssString(href.slice(1))}")`; // an SVG's own paint, filter...
    const resolved = href && !href.startsWith('data:') ? resolveHref(basePath, href) : null;
    const url = resolved ? await resource(resolved.path) : null;
    return url ? `url("${cssString(url)}")` : 'none';
  }));
  let i = 0;
  // Each one stands in as a mark (NULs can't be in `css` any more) while what's left is checked,
  // so it isn't taken for one of the book's own url()s.
  css = css.replace(URL_TOKEN, () => `\u0000${i++}\u0000`);
  css = css.replace(FETCHING_FUNCTION, '$1x-blocked(');
  // eslint-disable-next-line no-control-regex -- the marks above
  return css.replace(/\u0000(\d+)\u0000/g, (_m, n) => urls[Number(n)]);
}

const cssString = (value) => value.replace(/["\\\n\r\f]/g, '');

// ---- Markup ----

const LINK_SCHEMES = /^(?:https?|mailto):/i;

// A link's href inside the reader: `#epub:<chapter>:<fragment>`, which EpubReader turns into
// going there. Exported for it.
export const INTERNAL_LINK = /^#epub:(\d+):(.*)$/;
const internalLink = (index, fragment) => `#epub:${index}:${encodeURIComponent(fragment)}`;

// Rewrites every address in `root` (DOMPurify's output, still outside the page) as the comment
// at the top says. `ctx`: { path (the page's file), chapterIndex(path) -> spine index or -1,
// resource(path) -> blob URL or null, svg(path) -> sanitised SVG fragment or null }.
async function rewrite(root, ctx, { insideSvgFile = false } = {}) {
  const work = [];
  for (const el of [...root.querySelectorAll('*')]) {
    const tag = el.localName.toLowerCase();
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (/^on/.test(name) || FORBID_ATTR.includes(name)) {
        el.removeAttributeNode(attr);
      } else if (name === 'style') {
        work.push(sanitizeCss(value, ctx.path, ctx.resource).then((css) => el.setAttribute('style', css)));
      } else if (name === 'href' || name === 'xlink:href' || attr.localName === 'href') {
        el.removeAttributeNode(attr);
        if (tag === 'a') {
          const href = linkFor(value, ctx);
          if (href) {
            el.setAttribute('href', href);
            if (!href.startsWith('#')) {
              el.setAttribute('target', '_blank');
              el.setAttribute('rel', 'noopener noreferrer');
            }
          }
        } else if (tag === 'image' || tag === 'feimage') {
          work.push(pictureUrl(value, ctx).then((url) => url && el.setAttribute('href', url)));
        } else if (value.trim().startsWith('#')) {
          el.setAttribute('href', value.trim()); // <use>, gradients...: only the SVG's own parts
        }
      } else if (name === 'src') {
        el.removeAttributeNode(attr);
        if (tag === 'img') work.push(placePicture(el, value, ctx, insideSvgFile));
      } else if (/url\s*\(/i.test(value) && !/^\s*url\(\s*["']?#[^)]*\)\s*$/i.test(value)) {
        el.removeAttributeNode(attr); // e.g. an SVG fill="url(https://…)"
      }
    }
    if (tag === 'style') {
      work.push(sanitizeCss(el.textContent, ctx.path, ctx.resource).then((css) => { el.textContent = css; }));
    }
  }
  await Promise.all(work);
}

function linkFor(value, ctx) {
  const href = value.trim();
  if (isExternal(href)) return LINK_SCHEMES.test(href) ? href : null;
  const resolved = resolveHref(ctx.path, href);
  const index = resolved ? ctx.chapterIndex(resolved.path) : -1;
  return index >= 0 ? internalLink(index, resolved.fragment) : null;
}

async function pictureUrl(value, ctx) {
  const resolved = isExternal(value.trim()) ? null : resolveHref(ctx.path, value);
  return resolved ? ctx.resource(resolved.path) : null;
}

// An <img>: the book's PNG, JPEG, GIF or WebP as a blob URL, its SVG put inline in its place
// (not inside another SVG file), anything else nothing but its alt text.
async function placePicture(img, value, ctx, insideSvgFile) {
  const resolved = isExternal(value.trim()) ? null : resolveHref(ctx.path, value);
  if (!resolved) return;
  const url = await ctx.resource(resolved.path);
  if (url) {
    img.setAttribute('src', url);
    return;
  }
  const svg = insideSvgFile ? null : await ctx.svg(resolved.path);
  if (!svg) return;
  const box = img.ownerDocument.createElement('span');
  box.className = `epub-svg-image ${img.getAttribute('class') ?? ''}`.trim();
  box.setAttribute('role', 'img');
  if (img.getAttribute('alt')) box.setAttribute('aria-label', img.getAttribute('alt'));
  if (img.getAttribute('style')) box.setAttribute('style', img.getAttribute('style'));
  box.append(svg);
  img.replaceWith(box);
}

// A chapter's body (its markup, as a string) -> a DocumentFragment fit to show.
export async function sanitizeChapter(markup, ctx) {
  const fragment = purify().sanitize(markup, HTML_CONFIG);
  await rewrite(fragment, ctx);
  return fragment;
}

// An SVG file of the book (`text`, at `path`) -> a fragment of its sanitised <svg>, its own
// pictures resolved (but no SVGs inside it), or null.
export async function sanitizeSvgFile(text, ctx) {
  const fragment = purify().sanitize(text, SVG_CONFIG);
  if (!fragment.querySelector('svg')) return null;
  await rewrite(fragment, ctx, { insideSvgFile: true });
  return fragment;
}
