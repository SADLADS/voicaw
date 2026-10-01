// What guild search sees of a message (db.js keeps the index, routes/guildSearch.js searches
// it): its words (`searchText`, for the full-text index) and what it has (`searchHas`, a bit
// field for `has:`). Pure functions of the stored row, so the index can be rebuilt any time.

// `has:` values, as in Discord's search (no stickers or forwards here).
const HAS = {
  link: 1,
  embed: 2,
  file: 4, // any attachment (not a GIF from the picker)
  image: 8,
  video: 16,
  sound: 32,
  poll: 64,
};

const POLL_PREFIX = 'poll:v1:';
// `![alt](url)` (client utils/attachmentMarkup.js): attachments, GIFs, other images.
const EMBED_RE = /!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;

function parseJsonList(json) {
  try {
    const value = json ? JSON.parse(json) : [];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parsePoll(content) {
  if (!content.startsWith(POLL_PREFIX)) return null;
  try {
    const poll = JSON.parse(content.slice(POLL_PREFIX.length));
    return poll && typeof poll === 'object' ? poll : null;
  } catch {
    return null;
  }
}

// The kind of file a MIME type is, as a `has:` bit (0: none of image/video/sound).
function mediaBit(type) {
  const kind = String(type ?? '').split('/')[0];
  return kind === 'image' ? HAS.image : kind === 'video' ? HAS.video : kind === 'audio' ? HAS.sound : 0;
}

// The `has:` bits of one `![alt](url)`: an upload (`#v=1&…&t=<mime>`, services/attachmentCrypto)
// is a file of its type, a GIF (`#gif`) or any other image URL an image.
function markdownImageBits(url) {
  const hashIndex = url.indexOf('#');
  const params = new URLSearchParams(hashIndex === -1 ? '' : url.slice(hashIndex + 1));
  if (params.has('v') && params.has('k')) return HAS.file | mediaBit(params.get('t'));
  return HAS.image;
}

// { content, embeds, attachments } (the stored columns) → the `has:` bit field.
function searchHas({ content, embeds, attachments }) {
  const text = String(content ?? '');
  let bits = 0;
  if (parsePoll(text)) return HAS.poll;
  for (const [, , url] of text.matchAll(EMBED_RE)) bits |= markdownImageBits(url);
  if (/\bhttps?:\/\/\S/i.test(text.replace(EMBED_RE, ' '))) bits |= HAS.link;
  if (parseJsonList(embeds).length) bits |= HAS.embed;
  for (const file of parseJsonList(attachments)) bits |= HAS.file | mediaBit(file?.content_type);
  return bits;
}

// The words to index: the text without mentions (`mentions:` finds people) or channel ids, attachments by
// name (never their key-carrying links), custom emoji by name, a poll's question and answers,
// and a webhook's embeds and file names.
function searchText({ content, embeds, attachments }) {
  const text = String(content ?? '');
  const parts = [];
  const poll = parsePoll(text);
  if (poll) {
    parts.push(poll.q, ...(Array.isArray(poll.o) ? poll.o.map((o) => o?.t) : []));
  } else {
    parts.push(text
      .replace(EMBED_RE, (_, alt, url) => (url.includes('#gif') ? ' ' : ` ${alt.replace(/\\(.)/g, '$1')} `))
      .replace(/<:([A-Za-z0-9_]+):\d+>/g, ' $1 ')
      .replace(/<@&?\d+>|<#\d+>/g, ' '));
  }
  for (const embed of parseJsonList(embeds)) {
    if (!embed || typeof embed !== 'object') continue;
    parts.push(embed.title, embed.description, embed.author?.name, embed.footer?.text, embed.provider?.name);
    for (const field of Array.isArray(embed.fields) ? embed.fields : []) parts.push(field?.name, field?.value);
  }
  for (const file of parseJsonList(attachments)) parts.push(file?.filename, file?.description);
  return parts.filter((p) => typeof p === 'string' && p).join('\n');
}

module.exports = { HAS, searchHas, searchText };
