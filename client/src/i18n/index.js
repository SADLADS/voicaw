import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// The app's text. Each language is a folder (en-GB/, ru/, ja/) with one file per area of the app
// ({ "settings": { ... } } in settings.json), and keys start with the area:
// t('settings.privacy.title'). Strings are looked up synchronously from the bundle, so `t` can
// be called anywhere (components, hooks, services) as soon as this module is imported. Anything
// missing from a language shows in British English. See Translations in docs/client.md.
const files = import.meta.glob('./*/*.json', { eager: true, import: 'default' });

export const FALLBACK_LANGUAGE = 'en-GB';

// The languages to choose from, each named in itself.
export const LANGUAGES = [
  { code: 'en-GB', name: 'English (UK)' },
  { code: 'ru', name: 'Русский' },
  { code: 'ja', name: '日本語' },
];

export const resources = {};
for (const [path, data] of Object.entries(files)) {
  const code = path.split('/')[1];
  resources[code] ??= { translation: {} };
  Object.assign(resources[code].translation, data);
}

const STORAGE_KEY = 'voicaw-language';

// The language chosen on this device (Settings → Language), or null to follow the browser.
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

i18n.use(initReactI18next).init({
  lng: LANGUAGE,
  fallbackLng: FALLBACK_LANGUAGE,
  resources,
  initAsync: false,
  // React escapes text itself.
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

if (typeof document !== 'undefined') document.documentElement.lang = LANGUAGE;

// Translate a key: t('settings.privacy.title'), t('guilds.members', { count }). A language
// change reloads the app, so a plain function (no hook) is enough, even in memoised components.
export const t = i18n.t.bind(i18n);

export default i18n;
