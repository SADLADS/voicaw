// Custom (guild) emoji: plain images in the object store at emojis/<id>, written `<:name:id>`
// in message text. The id is all that's needed to show one, so rendering never waits for
// the emoji list; the list (CustomEmojiContext) is only for the picker and autocomplete.

let baseUrl = '';

// Called once the server config (with the object store's address) has loaded.
export function setCustomEmojiBase(s3Endpoint) {
  baseUrl = s3Endpoint ? `${s3Endpoint}/emojis/` : '';
}

// Its image URL (`s3Endpoint` if given, else the one set at start); null before either is known.
export function customEmojiUrl(id, s3Endpoint) {
  if (s3Endpoint) return `${s3Endpoint}/emojis/${id}`;
  return baseUrl ? `${baseUrl}${id}` : null;
}

// A fresh global regex each call (they're stateful).
export const customEmojiPattern = () => /<:([A-Za-z0-9_]{2,32}):(\d+)>/g;

export const customEmojiText = (emoji) => `<:${emoji.name}:${emoji.id}>`;

// `{ name, id }` if `text` is exactly one custom emoji (e.g. a reaction), else null.
export function parseCustomEmoji(text) {
  const m = /^<:([A-Za-z0-9_]{2,32}):(\d+)>$/.exec(text ?? '');
  return m ? { name: m[1], id: m[2] } : null;
}

// For plain-text places (reply previews, notifications, copying): `<:name:id>` → `:name:`.
export function customEmojiToText(text) {
  return text == null ? text : String(text).replace(customEmojiPattern(), ':$1:');
}

// The picker's "Frequently Used" keeps custom emoji as `custom:<id>`.
export const customUsageId = (id) => `custom:${id}`;

// Custom emoji matching a search, best first: exact name, then starting with it, then containing it.
export function searchCustomEmoji(custom, query, limit = 50) {
  const q = query.toLowerCase().replace(/^:|:$/g, '').trim().replace(/\s+/g, '_');
  if (!q) return [];
  const ranked = [];
  for (const { emojis } of custom.guilds) {
    for (const emoji of emojis) {
      const name = emoji.name.toLowerCase();
      const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : -1;
      if (rank >= 0) ranked.push([rank, emoji]);
    }
  }
  return ranked.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, e]) => e);
}

// The custom emoji called `name` (the first, in rail order, if several guilds have one).
export function customEmojiByName(custom, name) {
  for (const { emojis } of custom.guilds) {
    const found = emojis.find((e) => e.name === name);
    if (found) return found;
  }
  return null;
}
