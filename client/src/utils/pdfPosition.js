// Where each PDF was left, on this device only (localStorage `pdfPosition:<key>`, the key being
// the attachment's file name in the store, utils/readerPosition.js): { page (from 1), fraction
// (how far down that page) }. Logging out deletes them (services/logout.js). The zoom is the
// device's own (`pdfZoom`): 'auto' (the page's width, at most 125%: PDF.js's), 'page-width',
// 'page-fit' or a scale (0.25 to 5).

const PREFIX = 'pdfPosition:';
const ZOOM_KEY = 'pdfZoom';
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 5;
export const NAMED_ZOOMS = ['auto', 'page-width', 'page-fit'];

export function readPosition(key) {
  if (!key) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(PREFIX + key));
    const page = Number(saved?.page);
    const fraction = Number(saved?.fraction);
    if (!Number.isInteger(page) || page < 1) return null;
    return { page, fraction: Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0 };
  } catch {
    return null;
  }
}

export function savePosition(key, { page, fraction }) {
  if (!key || !Number.isInteger(page) || page < 1) return;
  try {
    const clamped = Math.min(1, Math.max(0, Number(fraction) || 0));
    localStorage.setItem(PREFIX + key, JSON.stringify({ page, fraction: Math.round(clamped * 1000) / 1000 }));
  } catch { /* storage full or blocked */ }
}

// A zoom as stored or chosen: a named one, or a scale within bounds; anything else is null.
export function validZoom(value) {
  if (NAMED_ZOOMS.includes(value)) return value;
  const scale = Number(value);
  return Number.isFinite(scale) && scale >= MIN_SCALE && scale <= MAX_SCALE ? scale : null;
}

// `fallback`: the zoom when none was chosen on this device (automatic, the reader's default).
export function readZoom(fallback = 'auto') {
  try {
    return validZoom(localStorage.getItem(ZOOM_KEY)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveZoom(zoom) {
  const valid = validZoom(zoom);
  if (valid == null) return;
  try {
    localStorage.setItem(ZOOM_KEY, String(typeof valid === 'number' ? Math.round(valid * 100) / 100 : valid));
  } catch { /* storage blocked */ }
}
