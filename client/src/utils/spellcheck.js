import { useSyncExternalStore } from 'react';

// Spellcheck while typing, per device: on or off (localStorage `spellcheck`: 'off' turns it
// off; on by default) and which language (localStorage `spellcheckLanguage`: 'auto', the
// default, picks from the browser's languages, else one of SPELLCHECK_LANGUAGES).
//
// The checking is ours (spellcheck/), the same in every browser and the desktop app, when
// there's a dictionary for the language: the editors (messages, documents) draw its
// underlines and turn the browser's off. Plain text boxes keep the browser's underlines (only
// it can draw in them) and get our suggestions on right click. With no dictionary for the
// language, it's the browser's checker everywhere, as before. The choice is set on <html>:
// every text box without its own `spellcheck` inherits it.

const STORAGE_KEY = 'spellcheck';
const LANGUAGE_KEY = 'spellcheckLanguage';
const listeners = new Set();

// Ours (spellcheck/dictionaries.js). labelKey: the name Settings shows (an i18n key).
export const SPELLCHECK_LANGUAGES = [
  { code: 'en-GB', labelKey: 'settings.spellcheck.languages.enGB' },
  { code: 'en-US', labelKey: 'settings.spellcheck.languages.enUS' },
];

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not remembered, then.
  }
}

// The language our checker uses for `choice`, or null for none of ours. 'auto': the first of
// the browser's languages we have; English other than American is British.
export function resolveSpellcheckLanguage(choice, languages = []) {
  if (SPELLCHECK_LANGUAGES.some((l) => l.code === choice)) return choice;
  for (const locale of languages) {
    const lower = String(locale).toLowerCase();
    if (lower === 'en-us') return 'en-US';
    if (lower === 'en' || lower.startsWith('en-')) return 'en-GB';
  }
  return null;
}

const browserLanguages = () => (typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]);

function withLanguage(enabled, choice) {
  // `language`: our checker's, or null (off, or the browser's checker).
  return { enabled, choice, language: enabled ? resolveSpellcheckLanguage(choice, browserLanguages()) : null };
}

function load() {
  return withLanguage(read(STORAGE_KEY) !== 'off', read(LANGUAGE_KEY) || 'auto');
}

let settings = load();

export function isSpellcheckEnabled() {
  return settings.enabled;
}

// The language our own checker runs in, or null when it isn't the one checking.
export function spellcheckLanguage() {
  return settings.language;
}

export function spellcheckSettings() {
  return settings;
}

// Puts the choice on the page (at startup and on every change).
export function applySpellcheck() {
  if (typeof document !== 'undefined') document.documentElement.spellcheck = settings.enabled;
}

function changed(enabled, choice) {
  settings = withLanguage(enabled, choice);
  applySpellcheck();
  listeners.forEach((listener) => listener());
}

export function setSpellcheckEnabled(value) {
  write(STORAGE_KEY, value ? null : 'off');
  changed(Boolean(value), settings.choice);
}

export function setSpellcheckLanguage(choice) {
  write(LANGUAGE_KEY, choice === 'auto' ? null : choice);
  changed(settings.enabled, choice);
}

export function subscribeSpellcheck(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSpellcheck() {
  return useSyncExternalStore(subscribeSpellcheck, isSpellcheckEnabled);
}

// { enabled, choice, language }
export function useSpellcheckSettings() {
  return useSyncExternalStore(subscribeSpellcheck, spellcheckSettings);
}
