import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// What the page's i18n (index.js) and the service worker's (worker.js) share: the languages,
// which one this device uses, and setting up i18next. See Translations in docs/client.md.

export const FALLBACK_LANGUAGE = 'en-GB';

// The languages to choose from, each named in itself.
export const LANGUAGES = [
  { code: 'en-GB', name: 'English (UK)' },
  { code: 'ru', name: 'Русский' },
  { code: 'ja', name: '日本語' },
  { code: 'th', name: 'ไทย' },
];

const STORAGE_KEY = 'voicaw-language';

// The language chosen on this device (Settings → Language), or null to follow the browser. (A
// service worker has no localStorage: it follows the browser.)
export function languageChoice() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.some((l) => l.code === stored) ? stored : null;
  } catch {
    return null;
  }
}

// The browser's (on a computer, the system's) language if we have it, else British English.
function browserLanguage() {
  const wanted = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
  for (const tag of wanted) {
    const found = LANGUAGES.find((l) => l.code === tag) ?? LANGUAGES.find((l) => l.code === tag?.split('-')[0]);
    if (found) return found.code;
  }
  return FALLBACK_LANGUAGE;
}

export const LANGUAGE = languageChoice() ?? browserLanguage();

// Changing language reloads the app, so everything (module-level labels too) is redrawn in it.
// `code` null follows the browser again.
export function setLanguage(code) {
  try {
    if (code) localStorage.setItem(STORAGE_KEY, code);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: only this page load changes, which the reload undoes.
  }
  location.reload();
}

// Sets i18next up with `resources` ({ <code>: { translation } }).
export function initI18n(resources) {
  i18n.use(initReactI18next).init({
    lng: LANGUAGE,
    fallbackLng: FALLBACK_LANGUAGE,
    resources,
    initAsync: false,
    // React escapes text itself.
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return i18n;
}
