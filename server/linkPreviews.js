const db = require('./db');
const { safeFetch } = require('./safeFetch');
const { getSetting } = require('./appSettings');

// Link previews in guild messages, as Discord makes them: after a message is sent or edited,
// the server fetches the web addresses in it (up to MAX_LINKS) and keeps what it found as
// Discord-shaped embeds in `guild_messages.link_embeds` (JSON), then tells the channel
// (`guild_message_embeds`; bots get MESSAGE_UPDATE). A page gives its OpenGraph / Twitter card
// (site, title, description, colour, picture, a video file); a link straight to an image or a
// video gives that. Only guilds: they aren't end-to-end encrypted, so the server already has
// the text. DMs and group DMs never come here (the sender's desktop or Android app makes their
// previews and stores them encrypted, `link_previews`; see the client's linkPreviewCrypto.js and
// pageEmbed.js, whose embedFromHtml is a copy of this one). Off for the whole app with Settings → Admin's
// "Link previews" (appSettings.js `linkPreviews`). Links in code, in spoilers or written as
// <https://…> are left alone, and SUPPRESS_EMBEDS (the author's or a moderator's "Remove
// previews") hides them. Pictures aren't copied: readers load them from the site (see
// docs/messages.md, Link previews).

const MAX_LINKS = 5;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_MEDIA_HEADER_BYTES = 256 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
const FAILED_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 1000;
const MAX_CONCURRENT = 4;
const MAX_QUEUED = 100;
const USER_AGENT = 'Mozilla/5.0 (compatible; VoicawBot/1.0; +https://voicaw.com/)';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg']);

const LINK_RE = /https?:\/\/[^\s<>"'`|]+/gi;

// The web addresses in `content` that get previews, in order, at most MAX_LINKS, without
// repeats: not in code, spoilers, <…> or a markdown image, trailing punctuation dropped (and a
// closing bracket the link didn't open).
function linksIn(content) {
  if (typeof content !== 'string') return [];
  const text = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\|\|[\s\S]*?\|\|/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<https?:\/\/[^\s>]*>/gi, ' ');
  const links = [];
  for (let [link] of text.matchAll(LINK_RE)) {
    link = link.replace(/[.,!?:;*_~]+$/, '');
    while (link.endsWith(')') && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0)) {
      link = link.slice(0, -1).replace(/[.,!?:;*_~]+$/, '');
    }
    try {
      link = new URL(link).href;
    } catch {
      continue;
    }
    if (!links.includes(link)) links.push(link);
    if (links.length === MAX_LINKS) break;
  }
  return links;
}

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

// What a page says about itself: its <head>'s meta tags and title. Resolves to an embed for
// `link` (fetched as `pageUrl`), or null when it says nothing worth showing.
function embedFromHtml(html, link, pageUrl) {
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
    const image = { url: imageUrl, width: positive(meta['og:image:width']), height: positive(meta['og:image:height']) };
    // A big picture under the text when the page asks for one (or has a video), else a small one beside it.
    if (meta['twitter:card'] === 'summary_large_image' || videoUrl) embed.image = image;
    else embed.thumbnail = image;
  }
  if (videoUrl) embed.video = { url: videoUrl, width: positive(meta['og:video:width']), height: positive(meta['og:video:height']) };
  return embed;
}

// An image's size from its first bytes (sharp reads only the header), if it can tell.
async function imageSize(buffer) {
  try {
    const sharp = require('sharp');
    const { width, height } = await sharp(buffer, { failOn: 'none' }).metadata();
    return { width: positive(width), height: positive(height) };
  } catch {
    return {};
  }
}

function decodeHtml(body, charset) {
  const declared = charset ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1];
  try {
    return new TextDecoder(declared ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

// The preview for one link: an embed, or null (nothing to show, or it couldn't be fetched).
async function fetchPreview(link) {
  const res = await safeFetch(link, {
    // Pages are read up to their <head>'s likely end; of a picture only its header, of a video nothing.
    maxBytes: (type) => (IMAGE_TYPES.has(type) ? MAX_MEDIA_HEADER_BYTES : VIDEO_TYPES.has(type) ? 0 : MAX_HTML_BYTES),
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,image/*,video/*;q=0.8,*/*;q=0.5' },
  });
  if (res.status !== 200) return null;
  if (IMAGE_TYPES.has(res.contentType)) {
    const size = await imageSize(res.body);
    return { type: 'image', url: link, thumbnail: { url: res.url, ...size } };
  }
  if (VIDEO_TYPES.has(res.contentType)) return { type: 'video', url: link, video: { url: res.url } };
  if (res.contentType !== 'text/html' && res.contentType !== 'application/xhtml+xml') return null;
  return embedFromHtml(decodeHtml(res.body, res.charset), link, res.url);
}

// ---- Cache and queue ----

const cache = new Map(); // link -> { embed, expires }
let running = 0;
const waiting = [];

async function withSlot(task) {
  if (running >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED) return null;
    await new Promise((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

async function previewFor(link) {
  const hit = cache.get(link);
  if (hit && hit.expires > Date.now()) return hit.embed;
  let embed = null;
  try {
    embed = await withSlot(() => module.exports.fetchPreview(link));
  } catch {
    embed = null;
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(link, { embed, expires: Date.now() + (embed ? CACHE_TTL_MS : FAILED_TTL_MS) });
  return embed;
}

function parseList(json) {
  try {
    const value = json ? JSON.parse(json) : [];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const sameLinks = (a, b) => a.length === b.length && a.every((link, i) => link === b[i]);

const pending = new Set();

// Works out message `messageId`'s link previews again after its content changed (or it was
// sent), and tells its channel if they changed. Nothing is fetched when its links are the
// ones it already has previews for. Never throws (failures are logged).
function refreshLinkPreviews(messageId) {
  const work = (async () => {
    if ((await getSetting('linkPreviews')) === 'off') return;
    const row = await db.get('SELECT content, channel_id, system, link_embeds, link_urls FROM guild_messages WHERE id = ?', [messageId]);
    if (!row || row.system) return;
    const links = linksIn(row.content);
    if (sameLinks(links, parseList(row.link_urls))) return;
    const embeds = (await Promise.all(links.map(previewFor))).filter(Boolean);
    // An edit while these were fetched has started its own refresh.
    const now = await db.get('SELECT content FROM guild_messages WHERE id = ?', [messageId]);
    if (!now || !sameLinks(linksIn(now.content), links)) return;
    const json = embeds.length ? JSON.stringify(embeds) : null;
    await db.run('UPDATE guild_messages SET link_embeds = ?, link_urls = ? WHERE id = ?', [json, links.length ? JSON.stringify(links) : null, messageId]);
    if (json === (row.link_embeds ?? null)) return;
    const channel = await db.get('SELECT id, guild_id, name, type FROM guild_channels WHERE id = ?', [row.channel_id]);
    if (!channel) return;
    const { sendToChannel } = require('./guilds');
    await sendToChannel(channel, {
      type: 'guild_message_embeds',
      guildId: channel.guild_id,
      channelId: channel.id,
      messageId,
      link_embeds: embeds,
    });
  })().catch((err) => console.error('Link preview failed:', err.message));
  pending.add(work);
  work.finally(() => pending.delete(work));
  return work;
}

// For tests: resolves once every refresh started so far is done.
const settled = () => Promise.all([...pending]);

const clearCache = () => cache.clear();

module.exports = { linksIn, embedFromHtml, fetchPreview, refreshLinkPreviews, settled, clearCache };
