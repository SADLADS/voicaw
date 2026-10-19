// The user's language (BCP 47, e.g. 'en-GB'): the browser's (on a computer, the system's), or
// British English if it has none. Used for "automatic" date and time formats and as the
// language typed in the message box (which dictionary the browser checks spelling with).
// Kept per browser language: it's asked for every date drawn, and checking one is slow.
let known = { language: undefined, locale: undefined };
export function userLocale() {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const language = nav?.language || nav?.languages?.[0];
  if (known.language === language && known.locale) return known.locale;
  let locale;
  try {
    locale = language ? Intl.getCanonicalLocales(language)[0] : 'en-GB';
  } catch {
    locale = 'en-GB';
  }
  known = { language, locale };
  return locale;
}
