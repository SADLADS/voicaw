// While composing, attachments live only in the browser and are referenced from the
// message markdown as `![name](attachment:ID)`. On send, each placeholder URL is swapped
// for the real (encrypted) upload URL, so every attachment in a sent message is just a
// markdown image: `![name](https://…/uploads/<uuid>.bin#…)`. The renderer decides from
// the URL's metadata whether to show it as an image, a video or a download box.

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

// Swaps `attachment:ID` URLs for urlsById[ID], keeping the alt text.
export function replacePlaceholders(text, urlsById) {
  return text.replace(EMBED_RE, (match, alt, url) => {
    const id = placeholderIdFromUrl(url);
    return id !== null && urlsById[id] ? `![${alt}](${urlsById[id]})` : match;
  });
}

// For places that show raw message text (notifications, reply previews): replaces each
// embed with a short label so attachment URLs and keys aren't shown.
export function summarizeAttachments(text) {
  if (!text) return text;
  return text.replace(EMBED_RE, (match, alt) => `📎 ${unescapeAltText(alt) || 'attachment'}`);
}
