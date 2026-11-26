// Where each book was left, on this device only (localStorage `epubPosition:<key>`, the key being
// the attachment's file name in the store): { index (chapter), fraction (how far down it) }.
// Logging out deletes them (services/logout.js). The text size is the device's own.

const PREFIX = 'epubPosition:';
const TEXT_SIZE_KEY = 'epubTextSize';
export const TEXT_SIZES = [80, 90, 100, 115, 130, 150, 175, 200];

export function readPosition(key) {
  if (!key) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(PREFIX + key));
    const index = Number(saved?.index);
    const fraction = Number(saved?.fraction);
    if (!Number.isInteger(index) || index < 0) return null;
    return { index, fraction: Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0 };
  } catch {
    return null;
  }
}

export function savePosition(key, { index, fraction }) {
  if (!key) return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ index, fraction: Math.round(fraction * 1000) / 1000 }));
  } catch { /* storage full or blocked */ }
}

// The file's own name in the store (`<uuid>.bin`), from its address.
export function positionKeyFor(fileUrl) {
  const name = String(fileUrl ?? '').split('#')[0].split('?')[0].split('/').pop();
  return name || null;
}

export function readTextSize() {
  try {
    const size = Number(localStorage.getItem(TEXT_SIZE_KEY));
    return TEXT_SIZES.includes(size) ? size : 100;
  } catch {
    return 100;
  }
}

export function saveTextSize(size) {
  try {
    if (size === 100) localStorage.removeItem(TEXT_SIZE_KEY);
    else localStorage.setItem(TEXT_SIZE_KEY, String(size));
  } catch { /* storage blocked */ }
}
