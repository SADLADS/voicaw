import { useSyncExternalStore } from 'react';
import { setAndroidSystemBars } from './android';

// The theme, per device (localStorage `theme`: 'light', 'familiar' (Ol' Familiar, Discord's Ash
// colours), 'halloween', 'christmas', 'slack' (Slack's colours), 'system', or nothing for dark, the default). Never sent to the server, so each
// browser (and the desktop app) keeps its own. 'system' follows the system's light or dark
// setting live (prefers-color-scheme).
//
// A theme is a :root[data-theme] block of colour tokens in voicaw.css; BASES says whether it's
// light or dark underneath (Bootstrap's data-bs-theme, the browser's color-scheme and code
// highlighting only have those two).
//
// It's put on <html> as data-theme (our colours, voicaw.css), data-bs-theme (Bootstrap's) and
// through those the CSS color-scheme, which is what makes the browser's own parts match: form
// controls and scrollbars. Not the on-screen keyboard: on iPhones and iPads it follows the
// system's light/dark mode (WebKit gives every field UIKeyboardAppearanceDefault and never
// looks at the page), and Android keyboards follow the system or their own setting. Only a
// native app can choose on iOS (UITextInputTraits.keyboardAppearance; in a Capacitor wrapper,
// @capacitor/keyboard's setStyle); on Android not even that.
//
// index.html has a copy of `resolve` that runs before the CSS, so a light page never starts dark.
//
// Seasonal themes (on unless Settings → Appearance turns them off, localStorage
// `seasonalThemesOff`): the first time the app runs in October it switches to Halloween, in
// December to Christmas, and remembers what it replaced (`seasonalTheme`: { theme, key
// ('christmas-2026'), previous, active }). Choosing a theme in Settings after that is kept
// (active goes false). Once the month is over, if the seasonal theme is still the one it put
// on, the one before comes back. Each season switches once a year, so choosing another theme
// in December isn't undone later that month.

export const THEMES = ['dark', 'light', 'familiar', 'halloween', 'christmas', 'slack', 'system'];
const BASES = { dark: 'dark', light: 'light', familiar: 'dark', halloween: 'dark', christmas: 'dark', slack: 'light' };
const STORAGE_KEY = 'theme';
const SEASONAL_KEY = 'seasonalTheme';
const SEASONAL_OFF_KEY = 'seasonalThemesOff';
// Month (0-11) → its theme.
const SEASONS = { 9: 'halloween', 11: 'christmas' };
const listeners = new Set();

function load() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(value) ? value : 'dark';
  } catch {
    return 'dark';
  }
}

let choice = load();

const systemQuery = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;

// 'dark', 'light', 'familiar', 'halloween', 'christmas' or 'slack': what the page actually shows.
export function resolveTheme(value = choice) {
  if (value === 'system') return systemQuery?.matches ? 'light' : 'dark';
  return BASES[value] ? value : 'dark';
}

export function getThemeChoice() {
  return choice;
}

// Puts the theme on the page (at startup, on every change, and when the system's changes).
export function applyTheme() {
  if (typeof document === 'undefined') return;
  const theme = resolveTheme();
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.bsTheme = BASES[theme];
  // The Android app: its status and navigation bars' background and icons.
  setAndroidSystemBars(BASES[theme] === 'light');
}

function store(value) {
  choice = THEMES.includes(value) ? value : 'dark';
  try {
    if (choice === 'dark') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Not remembered, then.
  }
  applyTheme();
  listeners.forEach((listener) => listener());
}

function loadSeasonal() {
  try {
    const record = JSON.parse(localStorage.getItem(SEASONAL_KEY));
    return record && typeof record.key === 'string' ? record : null;
  } catch {
    return null;
  }
}

function saveSeasonal(record) {
  try {
    if (record) localStorage.setItem(SEASONAL_KEY, JSON.stringify(record));
    else localStorage.removeItem(SEASONAL_KEY);
  } catch {
    // Not remembered, then.
  }
}

// The theme chosen in Settings: kept, even over a seasonal one.
export function setThemeChoice(value) {
  const record = loadSeasonal();
  if (record?.active) saveSeasonal({ ...record, active: false });
  store(value);
}

export function getSeasonalThemes() {
  try {
    return localStorage.getItem(SEASONAL_OFF_KEY) !== '1';
  } catch {
    return true;
  }
}

// Turning them off while a seasonal theme they put on is showing puts back the one before;
// turning them on in October or December switches at once.
export function setSeasonalThemes(on) {
  try {
    if (on) localStorage.removeItem(SEASONAL_OFF_KEY);
    else localStorage.setItem(SEASONAL_OFF_KEY, '1');
  } catch {
    // Not remembered, then.
  }
  if (on) {
    checkSeason();
  } else {
    const record = loadSeasonal();
    saveSeasonal(null);
    if (record?.active && choice === record.theme) store(record.previous);
  }
  listeners.forEach((listener) => listener());
}

// Switches to the season's theme, or back from the last one when its month is over.
export function checkSeason(now = new Date()) {
  if (!getSeasonalThemes()) return;
  const theme = SEASONS[now.getMonth()];
  const key = theme ? `${theme}-${now.getFullYear()}` : null;
  const record = loadSeasonal();
  if (record?.key === key) return;
  if (record) {
    saveSeasonal(null);
    if (record.active && choice === record.theme) store(record.previous);
  }
  if (theme) {
    // Already on it (chosen in Settings): nothing to put back afterwards.
    const active = choice !== theme;
    saveSeasonal({ theme, key, previous: choice, active });
    if (active) store(theme);
  }
}

// At startup, then hourly and whenever the app comes back into view, for an app left open
// over the 1st of the month.
export function startSeasonalThemes() {
  checkSeason();
  if (typeof window === 'undefined') return;
  setInterval(() => checkSeason(), 60 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkSeason();
  });
}

systemQuery?.addEventListener?.('change', () => {
  if (choice !== 'system') return;
  applyTheme();
  listeners.forEach((listener) => listener());
});

// Another tab of the app changed it: follow (that tab's choice is this device's too).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== SEASONAL_OFF_KEY && e.key !== null) return;
    choice = load();
    applyTheme();
    listeners.forEach((listener) => listener());
  });
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// { choice: one of THEMES, theme: what resolveTheme gives, seasonal: whether seasonal themes are on }
let snapshot = { choice, theme: resolveTheme(), seasonal: getSeasonalThemes() };
function getSnapshot() {
  const theme = resolveTheme();
  const seasonal = getSeasonalThemes();
  if (snapshot.choice !== choice || snapshot.theme !== theme || snapshot.seasonal !== seasonal) {
    snapshot = { choice, theme, seasonal };
  }
  return snapshot;
}

export function useTheme() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
