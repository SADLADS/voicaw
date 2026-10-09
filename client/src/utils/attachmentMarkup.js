// While composing, attachments live only in the browser and are referenced from the
// message markdown as `![name](attachment:ID)`. On send, each placeholder URL is swapped
// for the real (encrypted) upload URL, so every attachment in a sent message is just a
// markdown image: `![name](https://…/uploads/<uuid>.bin#…)`. The renderer decides from
// the URL's metadata whether to show it as an image, a video or a download box.

import { parsePoll, pollSummary } from './pollMarkup';
import { parseAttachmentUrl } from '../services/attachmentCrypto';
import { t } from '../i18n';

const PLACEHOLDER_PREFIX = 'attachment:';

// `![alt](url)` where alt may contain backslash-escaped characters.
const EMBED_RE = /!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;

// Backslash-escapes what markdown would otherwise interpret inside `![…]` (brackets,
// emphasis/code/strikethrough markers, entities), so the alt text — which is also the
// download file name — comes back out exactly as the original file name.
export function escapeAltText(name) {
  return name.replace(/[\\[\]*_`~&]/g, '\\$&');
}

export function unescapeAltText(alt) {
  return alt.replace(/\\(.)/g, '$1');
}

export function makePlaceholder(id, name) {
  return `![${escapeAltText(name)}](${PLACEHOLDER_PREFIX}${id})`;
}

// Returns the draft id for an `attachment:ID` URL, or null for any other URL.
export function placeholderIdFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(PLACEHOLDER_PREFIX)) return null;
  const id = Number(url.slice(PLACEHOLDER_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function findPlaceholderIds(text) {
  const ids = new Set();
  for (const [, , url] of text.matchAll(EMBED_RE)) {
    const id = placeholderIdFromUrl(url);
    if (id !== null) ids.add(id);
  }
  return ids;
}

export function removePlaceholder(text, id) {
  return text.replace(EMBED_RE, (match, alt, url) =>
    placeholderIdFromUrl(url) === id ? '' : match
  );
}

// Drops every `attachment:ID` placeholder (sent attachments stay).
export function removePlaceholders(text) {
  return text.replace(EMBED_RE, (match, alt, url) => (placeholderIdFromUrl(url) !== null ? '' : match));
}

// Swaps `attachment:ID` URLs for urlsById[ID], keeping the alt text.
export function replacePlaceholders(text, urlsById) {
  return text.replace(EMBED_RE, (match, alt, url) => {
    const id = placeholderIdFromUrl(url);
    return id !== null && urlsById[id] ? `![${alt}](${urlsById[id]})` : match;
  });
}

// A flag in an attachment URL's fragment (see services/attachmentCrypto): `sp=1` a spoiler,
// `vm=1` a voice message.
function fragmentFlag(url, name) {
  const hashIndex = url.indexOf('#');
  return hashIndex !== -1 && new URLSearchParams(url.slice(hashIndex + 1)).get(name) === '1';
}

// Whether a message is a voice message: one, alone (services/voiceMessage.js). They can't be
// edited, as in Discord.
export function isVoiceMessage(text) {
  const embeds = [...(text ?? '').matchAll(EMBED_RE)];
  return embeds.length === 1 && embeds[0][0] === text.trim() && fragmentFlag(embeds[0][2], 'vm');
}

// For places that show raw message text (notifications, reply previews): replaces each
// embed with a short label so attachment URLs and keys aren't shown. A spoiler's name could
// give it away, so it's just "spoiler". A voice message is "Voice message", a poll its question.
export function summarizeAttachments(text) {
  if (!text) return text;
  const poll = parsePoll(text);
  if (poll) return pollSummary(poll);
  return text.replace(EMBED_RE, (match, alt, url) => {
    if (fragmentFlag(url, 'vm')) return `🎤 ${t('media.voice.summary')}`;
    return fragmentFlag(url, 'sp') ? '📎 spoiler' : `📎 ${unescapeAltText(alt) || 'attachment'}`;
  });
}

// The uploads an encrypted message shows (its attachments, and their videos' posters and
// images' thumbnails), by their names in the bucket. Sent with the message: the server can't read it, and deletes
// files once no message lists them (docs/uploads.md, Deleting files).
export function uploadNamesIn(text) {
  const names = new Set();
  for (const [, , url] of (text ?? '').matchAll(EMBED_RE)) {
    const meta = parseAttachmentUrl(url);
    for (const fileUrl of [meta?.fileUrl, meta?.posterUrl]) {
      const at = fileUrl?.lastIndexOf('/uploads/') ?? -1;
      if (at !== -1) names.add(fileUrl.slice(at + '/uploads/'.length));
    }
  }
  return [...names];
}
