// The user's language (BCP 47, e.g. 'en-GB'): the browser's (on a computer, the system's), or
// British English if it has none. Used for "automatic" date and time formats and as the
// language typed in the message box (which dictionary the browser checks spelling with).
export function userLocale() {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const locale = nav?.language || nav?.languages?.[0];
  try {
    return locale ? Intl.getCanonicalLocales(locale)[0] : 'en-GB';
  } catch {
    return 'en-GB';
  }
}
