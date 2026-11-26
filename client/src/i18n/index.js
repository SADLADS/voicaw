import { FALLBACK_LANGUAGE, LANGUAGE, initI18n } from './core';

// The app's text. Each language is a folder (en-GB/, ru/, ja/, th/) with one file per area of the app
// ({ "settings": { ... } } in settings.json), and keys start with the area:
// t('settings.privacy.title'). Strings are looked up synchronously, so `t` can be called
// anywhere (components, hooks, services) as soon as this module is imported. Anything missing
// from a language shows in British English. See Translations in docs/client.md.
// British English is in the bundle; another language is loaded (its own file, vite.config.js)
// before this module finishes, so importers still find every string: bundling all four cost
// the desktop app ~1 MB of text on every start (Memory and start-up in docs/desktop-and-site.md).
// That wait is a top-level await, which a (classic) service worker can't run: the service
// worker's build uses worker.js instead (vite.config.js `serviceWorkerI18n`).
export { FALLBACK_LANGUAGE, LANGUAGES, LANGUAGE, languageChoice, setLanguage } from './core';

const english = import.meta.glob('./en-GB/*.json', { eager: true, import: 'default' });
const others = import.meta.glob(['./*/*.json', '!./en-GB/*.json'], { import: 'default' });

// The loaded languages' strings: British English, and LANGUAGE if it's another one (if it can't
// be loaded, the app is in British English this time).
export const resources = { [FALLBACK_LANGUAGE]: { translation: Object.assign({}, ...Object.values(english)) } };
if (LANGUAGE !== FALLBACK_LANGUAGE) {
  try {
    const loaders = Object.entries(others).filter(([path]) => path.split('/')[1] === LANGUAGE).map(([, load]) => load());
    resources[LANGUAGE] = { translation: Object.assign({}, ...(await Promise.all(loaders))) };
  } catch (err) {
    console.warn(`Could not load the ${LANGUAGE} translation`, err);
  }
}

const i18n = initI18n(resources);

if (typeof document !== 'undefined') document.documentElement.lang = LANGUAGE;

// Translate a key: t('settings.privacy.title'), t('guilds.members', { count }). A language
// change reloads the app, so a plain function (no hook) is enough, even in memoised components.
export const t = i18n.t.bind(i18n);

export default i18n;
