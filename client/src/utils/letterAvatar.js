// The picture of someone without one: their username's first character on a colour picked
// from their user id (so it never changes, even when they rename). An SVG data URL, so it goes
// anywhere a picture's URL does (Avatar's <img>, the game overlay) and takes the same CSS.

// Mid-tone colours white text reads on, in both themes.
const COLOURS = [
  '#e0525b', '#e06c3c', '#c98a14', '#5f9e32', '#22a06b', '#1d9a9a',
  '#2f8fd8', '#4f6fe0', '#7a5ae0', '#a54fd0', '#d04fa0', '#6b7a8f',
];

// FNV-1a: a small, stable hash, so the same id gets the same colour on every device.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function letterAvatarColour(userId) {
  return COLOURS[hash(String(userId ?? '')) % COLOURS.length];
}

const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const cache = new Map();

// `username` may be missing (a profile not loaded yet): then just the colour.
export function letterAvatar(userId, username) {
  // The first character, not the first UTF-16 unit (an emoji or accented letter stays whole).
  const letter = Array.from(username ?? '')[0]?.toLocaleUpperCase() ?? '';
  const key = `${userId}\n${letter}`;
  let url = cache.get(key);
  if (!url) {
    const text = letter.replace(/[&<>"']/g, (c) => escapes[c]);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
      + `<rect width="64" height="64" fill="${letterAvatarColour(userId)}"/>`
      + `<text x="32" y="32" dy=".35em" text-anchor="middle" fill="#fff" font-size="30" font-weight="600" `
      + `font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">${text}</text></svg>`;
    url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    cache.set(key, url);
  }
  return url;
}
