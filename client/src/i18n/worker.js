import { FALLBACK_LANGUAGE, LANGUAGE, initI18n } from './core';

// The service worker's i18n (its build resolves '../i18n' here: vite.config.js
// `serviceWorkerI18n`), for the notifications it words (services/pushNotifications.js). The same
// exports as index.js, but every language is in the bundle and nothing is awaited: a service
// worker can't load code later (no import()), and a top-level await stops a classic one from
// starting at all. It follows the browser's language (it has no localStorage).
export { FALLBACK_LANGUAGE, LANGUAGES, LANGUAGE, languageChoice, setLanguage } from './core';

const files = import.meta.glob('./*/*.json', { eager: true, import: 'default' });

export const resources = {};
for (const [path, strings] of Object.entries(files)) {
  const code = path.split('/')[1];
  if (code !== FALLBACK_LANGUAGE && code !== LANGUAGE) continue;
  resources[code] ??= { translation: {} };
  Object.assign(resources[code].translation, strings);
}

const i18n = initI18n(resources);

export const t = i18n.t.bind(i18n);

export default i18n;
