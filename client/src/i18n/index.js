import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// The app's text, in British English (the only language for now). Each file in en-GB/ is one
// area of the app ({ "settings": { ... } } in settings.json) and its keys start with the area:
// t('settings.privacy.title'). Strings are looked up synchronously from the bundle, so `t` can
// be called anywhere (components, hooks, services) as soon as this module is imported. See
// Translations in docs/client.md.
const files = import.meta.glob('./en-GB/*.json', { eager: true, import: 'default' });

export const LANGUAGE = 'en-GB';

export const resources = {
  [LANGUAGE]: { translation: Object.assign({}, ...Object.values(files)) },
};

i18n.use(initReactI18next).init({
  lng: LANGUAGE,
  fallbackLng: LANGUAGE,
  resources,
  initAsync: false,
  // React escapes text itself.
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

// Translate a key: t('settings.privacy.title'), t('guilds.members', { count }). A language
// change will reload the app, so a plain function (no hook) is enough, even in memoised
// components.
export const t = i18n.t.bind(i18n);

export default i18n;
