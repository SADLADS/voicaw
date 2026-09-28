// Per-device emoji preferences (like Discord's "Frequently Used" and skin tone).

const FREQUENT_KEY = 'emojiFrequent';
const SKIN_TONE_KEY = 'emojiSkinTone';

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function recordEmojiUse(id) {
  const counts = readJson(FREQUENT_KEY, {});
  counts[id] = (counts[id] || 0) + 1;
  localStorage.setItem(FREQUENT_KEY, JSON.stringify(counts));
}

// Most used emoji ids, most used first.
export function frequentEmojiIds(limit = 16) {
  return Object.entries(readJson(FREQUENT_KEY, {}))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

// 0 = default (yellow), 1-5 = light to dark.
export function getSkinTone() {
  const tone = Number(localStorage.getItem(SKIN_TONE_KEY));
  return Number.isInteger(tone) && tone >= 0 && tone <= 5 ? tone : 0;
}

export function setSkinTone(tone) {
  localStorage.setItem(SKIN_TONE_KEY, String(tone));
}

// The skin to use for an emoji given a tone (emoji without skin tones have one skin).
export function skinFor(emoji, tone) {
  return emoji.skins[emoji.skins.length === 6 ? tone : 0];
}
