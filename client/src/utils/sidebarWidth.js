// The width of the column beside the rail on a computer (DM list, a guild's channel list,
// Settings' sections): one width for all of them, dragged by its right edge, per device.

const KEY = 'sidebarWidth';

export const SIDEBAR_WIDTH = { min: 200, max: 420, default: 260 };

// What's left for the page beside it (the rail and the chat) is never squeezed below this.
const MIN_CONTENT = 72 + 360;

export function clampSidebarWidth(width, windowWidth = Infinity) {
  const max = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, windowWidth - MIN_CONTENT));
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default;
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH.min, width)));
}

export function parseSidebarWidth(value) {
  const width = Number(value);
  return value != null && value !== '' && Number.isFinite(width) ? clampSidebarWidth(width) : SIDEBAR_WIDTH.default;
}

export function loadSidebarWidth() {
  try {
    return parseSidebarWidth(localStorage.getItem(KEY));
  } catch {
    return SIDEBAR_WIDTH.default;
  }
}

export function saveSidebarWidth(width) {
  try {
    if (width === SIDEBAR_WIDTH.default) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(width));
  } catch {
    // Private mode or storage off: it just isn't remembered.
  }
}

// Another tab of the app changed it.
export function onSidebarWidthStorage(callback) {
  const listener = (e) => {
    if (e.key === KEY || e.key === null) callback(loadSidebarWidth());
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
