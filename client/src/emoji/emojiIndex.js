// Default (Unicode) emoji, Discord-style: data from @emoji-mart/data (Unicode 15, Twitter
// set: only emoji Twemoji has art for) and images from @twemoji/svg, served by this app at
// /emoji/<file>.svg (see the twemojiAssets plugin in vite.config.js), so nothing is fetched
// from a third party and a new install needs no setup. Messages store plain Unicode emoji;
// custom (guild) emoji are written `<:name:id>` (see customEmoji.js).

import { version as twemojiVersion } from '@twemoji/svg/package.json';
import { version as dataVersion } from '@emoji-mart/data/package.json';
import { sheetCss, sheetKey, sheetPath, spriteMap } from './emojiSheets';
import { twemojiFile } from './twemojiFile';

export { twemojiFile };

export const EMOJI_BASE_URL = `${import.meta.env.BASE_URL || '/'}emoji/`;

// The picker's sprite sheets (see emojiSheets.js).
const SHEET_KEY = sheetKey(twemojiVersion, dataVersion);
export const emojiSheetUrl = (name) => `${EMOJI_BASE_URL}${sheetPath(SHEET_KEY, name)}`;

const CATEGORY_NAMES = {
  people: 'Smileys & People',
  nature: 'Animals & Nature',
  foods: 'Food & Drink',
  activity: 'Activity',
  places: 'Travel & Places',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags',
};

export function emojiImageUrl(unified) {
  return `${EMOJI_BASE_URL}${twemojiFile(unified)}.svg`;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Builds lookups from the emoji-mart data set.
export function buildEmojiIndex(data) {
  const shortcodesById = new Map();
  for (const id of Object.keys(data.emojis)) shortcodesById.set(id, [id]);
  for (const [alias, id] of Object.entries(data.aliases || {})) shortcodesById.get(id)?.push(alias);

  const emojis = new Map();
  const byShortcode = new Map();
  const byNative = new Map();

  for (const raw of Object.values(data.emojis)) {
    const emoji = {
      id: raw.id,
      name: raw.name,
      keywords: raw.keywords || [],
      shortcodes: shortcodesById.get(raw.id),
      skins: raw.skins.map(({ unified, native }) => ({ unified, native })),
    };
    emojis.set(emoji.id, emoji);
    emoji.shortcodes.forEach((code) => byShortcode.set(code, emoji));
    emoji.skins.forEach((skin, skinIndex) => {
      const match = { emoji, skin, skinIndex };
      byNative.set(skin.native, match);
      // Keyboards often omit the FE0F variation selector (e.g. "❤" vs "❤️").
      const bare = skin.native.replace(/️/g, '');
      if (!byNative.has(bare)) byNative.set(bare, match);
    });
  }

  const categories = data.categories.map((c) => ({
    id: c.id,
    name: CATEGORY_NAMES[c.id] || c.id,
    emojis: c.emojis.map((id) => emojis.get(id)).filter(Boolean),
  }));

  // Longest first, so sequences (ZWJ families, flags, skin tones) win over their parts.
  const natives = [...byNative.keys()].sort((a, b) => b.length - a.length);
  const source = natives.map(escapeRegExp).join('|');

  function search(query, limit = 50) {
    const text = query.toLowerCase().replace(/^:|:$/g, '').trim();
    if (!text) return [];
    // "heart eyes" also searches as the shortcode "heart_eyes".
    const q = text.replace(/\s+/g, '_');
    const words = text.split(/\s+/);
    const ranked = [];
    for (const emoji of emojis.values()) {
      let rank = Infinity;
      for (const code of emoji.shortcodes) {
        if (code === q) rank = Math.min(rank, 0);
        else if (code.startsWith(q)) rank = Math.min(rank, 1);
        else if (code.includes(q)) rank = Math.min(rank, 3);
      }
      const name = emoji.name.toLowerCase();
      const nameWords = name.split(/\s+/);
      if (rank > 2 && (words.length === 1
        ? nameWords.some((w) => w.startsWith(text))
        : name.startsWith(text) || name.includes(` ${text}`))) rank = 2;
      if (rank > 4) {
        // Every word starts a word of the name, a keyword or a shortcode ("thumbs up").
        const tokens = [...nameWords, ...emoji.keywords, ...emoji.shortcodes.flatMap((c) => c.split('_'))];
        if (words.every((w) => tokens.some((t) => t.startsWith(w)))) rank = 4;
      }
      if (rank !== Infinity) ranked.push([rank, emoji]);
    }
    return ranked
      .sort((a, b) => a[0] - b[0] || a[1].id.length - b[1].id.length)
      .slice(0, limit)
      .map(([, emoji]) => emoji);
  }

  return {
    categories,
    emojis,
    byShortcode,
    byNative,
    search,
    // unified -> its cell in the picker's sprite sheets (see emojiSheets.js).
    sprites: spriteMap(data),
    // The sheets' CSS (emoji-sheet-<name> classes), for the picker to put on the page.
    sheetCss: sheetCss(data, emojiSheetUrl),
    // A fresh global regex each call (they're stateful).
    matcher: () => new RegExp(source, 'g'),
  };
}

let indexPromise = null;

// Loads the emoji data (~70KB gzipped) on first use.
export function loadEmojiIndex() {
  indexPromise ??= import('@emoji-mart/data/sets/15/twitter.json').then((m) => buildEmojiIndex(m.default ?? m));
  return indexPromise;
}

// Splits text into strings and emoji matches: [{ text }, { emoji, skin, native }].
export function splitEmoji(text, index) {
  const parts = [];
  const re = index.matcher();
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    const { emoji, skin } = index.byNative.get(m[0]);
    parts.push({ emoji, skin, native: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// Discord shows messages made only of emoji (up to 27, custom ones included) larger.
export function isEmojiOnly(text, index) {
  if (!text || !index) return false;
  const customCount = (text.match(/<:[A-Za-z0-9_]{2,32}:\d+>/g) ?? []).length;
  const rest = text.replace(/<:[A-Za-z0-9_]{2,32}:\d+>/g, ' ').trim();
  const parts = rest ? splitEmoji(rest, index) : [];
  const emojiCount = parts.filter((p) => p.emoji).length + customCount;
  return emojiCount > 0 && emojiCount <= 27 && parts.every((p) => p.emoji || !p.text.trim());
}
