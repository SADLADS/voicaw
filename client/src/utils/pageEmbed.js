// A link preview from a fetched page, made on this device for an end-to-end encrypted chat (see
// Link previews in docs/messages.md): the same Discord-shaped embed server/linkPreviews.js makes
// for guild messages, from the same OpenGraph / Twitter card tags. A copy of the server's
// `embedFromHtml`, tested alike (pageEmbed.test.js, server/test/linkPreviews.test.js): change
// both together.

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const clean = (text, max) => {
  if (typeof text !== 'string') return null;
  const value = decodeEntities(text).replace(/\s+/g, ' ').trim();
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
};

function attributes(tag) {
  const attrs = {};
  for (const [, name, quoted1, quoted2, bare] of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[name.toLowerCase()] = quoted1 ?? quoted2 ?? bare;
  }
  return attrs;
}

// An http(s) address, relative ones resolved against the page's.
function absolute(href, base) {
  if (!href) return null;
  try {
    const url = new URL(decodeEntities(href.trim()), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const positive = (value) => {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : undefined;
};

// A colour from theme-color (#rgb or #rrggbb), as Discord's integer.
function colorOf(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value?.trim() ?? '')?.[1];
  if (!hex) return undefined;
  return parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16);
}

// A picture or video's { url, width, height }, without the sizes it doesn't have.
function media(url, width, height) {
  const out = { url };
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  return out;
}

// What a page says about itself: its <head>'s meta tags and title. An embed for `link`
// (fetched as `pageUrl`), or null when it says nothing worth showing.
export function embedFromHtml(html, link, pageUrl) {
  const bodyAt = html.search(/<body[\s>]/i);
  const head = bodyAt === -1 ? html : html.slice(0, bodyAt);
  const meta = {};
  for (const [tag] of head.matchAll(/<meta\s[^>]*>/gi)) {
    const attrs = attributes(tag);
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop)?.toLowerCase();
    if (key && attrs.content != null && !(key in meta)) meta[key] = attrs.content;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = clean(meta['og:title'] ?? meta['twitter:title'] ?? titleTag, 256);
  const description = clean(meta['og:description'] ?? meta['twitter:description'] ?? meta.description, 350);
  const siteName = clean(meta['og:site_name'] ?? meta['application-name'], 256);
  const imageUrl = absolute(meta['og:image:secure_url'] ?? meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'] ?? meta['twitter:image:src'], pageUrl);
  const videoType = meta['og:video:type']?.toLowerCase();
  const videoUrl = VIDEO_TYPES.has(videoType)
    ? absolute(meta['og:video:secure_url'] ?? meta['og:video:url'] ?? meta['og:video'], pageUrl)
    : null;
  if (!title && !description && !imageUrl) return null;

  const embed = { type: videoUrl ? 'video' : (meta['og:type']?.startsWith('article') ? 'article' : 'link'), url: link };
  if (title) embed.title = title;
  if (description) embed.description = description;
  const color = colorOf(meta['theme-color']);
  if (color !== undefined) embed.color = color;
  if (siteName) embed.provider = { name: siteName };
  if (imageUrl) {
    const image = media(imageUrl, positive(meta['og:image:width']), positive(meta['og:image:height']));
    // A big picture under the text when the page asks for one (or has a video), else a small one beside it.
    if (meta['twitter:card'] === 'summary_large_image' || videoUrl) embed.image = image;
    else embed.thumbnail = image;
  }
  if (videoUrl) embed.video = media(videoUrl, positive(meta['og:video:width']), positive(meta['og:video:height']));
  return embed;
}

// The embed for `link` from what the desktop or Android app fetched (utils/pageFetch):
// { status, url (after redirects), contentType, html (pages only) }, or null.
export function embedFromResponse(res, link) {
  if (!res || res.status !== 200) return null;
  if (IMAGE_TYPES.has(res.contentType)) return { type: 'image', url: link, thumbnail: { url: res.url } };
  if (VIDEO_TYPES.has(res.contentType)) return { type: 'video', url: link, video: { url: res.url } };
  if (typeof res.html !== 'string') return null;
  return embedFromHtml(res.html, link, res.url);
}
