// Searching DMs, group DMs and notes on the device (services/searchIndex.js): what a message
// gives search (the same as guild search's server/searchText.js, a test checks they agree) and
// whether a message matches a search box's parameters (utils/searchQuery.js parseSearch), the
// way the server's guild search does (routes/guildSearch.js).

// `has:` bits, as the server's (no `embed`: an encrypted chat's link previews come later).
export const HAS = { link: 1, embed: 2, file: 4, image: 8, video: 16, sound: 32, poll: 64, forward: 128 };

export const ENCRYPTED_HAS_VALUES = ['link', 'file', 'image', 'video', 'sound', 'poll', 'forward'];

const POLL_PREFIX = 'poll:v1:';
const FORWARD_PREFIX = 'fwd:v1:';
// `![alt](url)` (utils/attachmentMarkup.js): attachments, GIFs, other images.
const EMBED_RE = /!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;

function parsePoll(text) {
  if (!text.startsWith(POLL_PREFIX)) return null;
  try {
    const poll = JSON.parse(text.slice(POLL_PREFIX.length));
    return poll && typeof poll === 'object' ? poll : null;
  } catch {
    return null;
  }
}

// A forward's text (utils/forwardMarkup.js): what it forwards, else null.
function forwarded(text) {
  if (!text.startsWith(FORWARD_PREFIX)) return null;
  const lineEnd = text.indexOf('\n');
  if (lineEnd === -1) return null;
  try {
    const header = JSON.parse(text.slice(FORWARD_PREFIX.length, lineEnd));
    return header && typeof header === 'object' && !Array.isArray(header) ? text.slice(lineEnd + 1) : null;
  } catch {
    return null;
  }
}

function mediaBit(type) {
  const kind = String(type ?? '').split('/')[0];
  return kind === 'image' ? HAS.image : kind === 'video' ? HAS.video : kind === 'audio' ? HAS.sound : 0;
}

function markdownImageBits(url) {
  const hashIndex = url.indexOf('#');
  const params = new URLSearchParams(hashIndex === -1 ? '' : url.slice(hashIndex + 1));
  if (params.has('v') && params.has('k')) return HAS.file | mediaBit(params.get('t'));
  return HAS.image;
}

// A message's text -> its `has:` bits.
export function searchHas(content) {
  const text = String(content ?? '');
  const inner = forwarded(text);
  if (inner != null) return HAS.forward | searchHas(inner);
  if (parsePoll(text)) return HAS.poll;
  let bits = 0;
  for (const [, , url] of text.matchAll(EMBED_RE)) bits |= markdownImageBits(url);
  if (/\bhttps?:\/\/\S/i.test(text.replace(EMBED_RE, ' '))) bits |= HAS.link;
  return bits;
}

// A message's text -> the words search sees: no mention ids, attachments by name (never their
// key-carrying links), GIFs left out, custom emoji by name, a poll's question and answers, a
// forward's text.
export function searchText(content) {
  const text = String(content ?? '');
  const inner = forwarded(text);
  if (inner != null) return searchText(inner);
  const poll = parsePoll(text);
  const parts = poll
    ? [poll.q, ...(Array.isArray(poll.o) ? poll.o.map((o) => o?.t) : [])]
    : [text
      .replace(EMBED_RE, (_, alt, url) => (url.includes('#gif') ? ' ' : ` ${alt.replace(/\\(.)/g, '$1')} `))
      .replace(/<:([A-Za-z0-9_]+):\d+>/g, ' $1 ')
      .replace(/<@&?\d+>|<#\d+>/g, ' ')];
  return parts.filter((p) => typeof p === 'string' && p).join('\n');
}

// Words as the server's index sees them (FTS5 unicode61, diacritics removed): letters and
// digits, lower case, without accents.
export function searchWords(text) {
  return String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// What the device keeps of a message to search it: the words, space separated.
export const indexedWords = (plaintext) => searchWords(searchText(plaintext)).join(' ');

// The `content` of a search -> [{ words, exact }] (every one must match: an unquoted word
// matches a word starting with it, a "quoted phrase" those words in a row) and `likes` (text
// with no letters or digits, an emoji, looked for in the message as written).
function parseContent(content) {
  const phrases = [];
  const likes = [];
  for (const [, phrase, word] of String(content ?? '').matchAll(/"([^"]*)"|(\S+)/g)) {
    const text = (phrase ?? word).trim();
    if (!text) continue;
    const words = searchWords(text);
    if (!words.length) likes.push(text);
    else phrases.push({ text: ` ${words.join(' ')}`, exact: phrase != null });
  }
  return { phrases, likes };
}

// The search box's parameters ({ content, author_id, mentions, has, before_time, after_time })
// -> a test of one kept message ({ s: sender id, t: time, p: its text, n: indexedWords, h:
// searchHas }). Times are unix seconds: before `before_time`, at or after `after_time`.
export function messageMatcher(params) {
  const { phrases, likes } = parseContent(params.content);
  const authors = new Set((params.author_id ?? []).map(String));
  const mentions = (params.mentions ?? []).map((id) => `<@${id}>`);
  const bits = (params.has ?? []).reduce((all, v) => all | (HAS[v] ?? 0), 0);
  return (entry) => {
    if (authors.size && !authors.has(String(entry.s))) return false;
    if (params.before_time != null && !(entry.t < params.before_time)) return false;
    if (params.after_time != null && !(entry.t >= params.after_time)) return false;
    if (bits && (entry.h & bits) !== bits) return false;
    if (mentions.some((m) => !entry.p.includes(m))) return false;
    if (likes.some((text) => !entry.p.includes(text))) return false;
    if (!phrases.length) return true;
    const words = ` ${entry.n} `;
    return phrases.every(({ text, exact }) => words.includes(exact ? `${text} ` : text));
  };
}
