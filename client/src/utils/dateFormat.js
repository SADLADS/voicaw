import { useSyncExternalStore } from 'react';
import { userLocale } from './locale';

// How dates and times are shown, chosen per device in Settings → Date & time (localStorage
// `dateFormat`). Every date or time the app shows goes through here.
// - date: 'auto' (the browser's language, else British), 'dmy' (30/09/2026), 'mdy' (09/30/2026), 'ymd' (2026-09-30)
// - time: 'auto', '12' (4:37 PM), '24' (16:37)
// Components read them with useDateFormat(), so they redraw when the choice changes.

const STORAGE_KEY = 'dateFormat';
export const DATE_FORMATS = ['auto', 'dmy', 'mdy', 'ymd'];
export const TIME_FORMATS = ['auto', '12', '24'];
const DEFAULTS = { date: 'auto', time: 'auto' };

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return {
      date: DATE_FORMATS.includes(saved?.date) ? saved.date : DEFAULTS.date,
      time: TIME_FORMATS.includes(saved?.time) ? saved.time : DEFAULTS.time,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let settings = load();
const listeners = new Set();

export function getDateSettings() {
  return settings;
}

// Changes some of { date, time } and remembers them on this device.
export function setDateSettings(changes) {
  settings = { ...settings, ...changes };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not remembered, then.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const pad = (n) => String(n).padStart(2, '0');
const toDate = (value) => (value instanceof Date ? value : new Date(value));

// The date alone: 30/09/2026 (or as chosen).
export function formatDate(value, { date = settings.date } = {}) {
  const d = toDate(value);
  switch (date) {
    case 'dmy': return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    case 'mdy': return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
    case 'ymd': return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    default: return d.toLocaleDateString(userLocale());
  }
}

// The date in words, for the day dividers in chats: 11 September 2026, or September 11, 2026
// for month first (the browser's way when automatic; 2026-09-11 when that's chosen).
export function formatLongDate(value, { date = settings.date } = {}) {
  const d = toDate(value);
  const month = d.toLocaleDateString(userLocale(), { month: 'long' });
  switch (date) {
    case 'dmy': return `${d.getDate()} ${month} ${d.getFullYear()}`;
    case 'mdy': return `${month} ${d.getDate()}, ${d.getFullYear()}`;
    case 'ymd': return formatDate(d, { date });
    default: return d.toLocaleDateString(userLocale(), { day: 'numeric', month: 'long', year: 'numeric' });
  }
}

// The time alone: 4:37 PM or 16:37 (or the browser's way), with seconds if asked.
export function formatTime(value, { seconds = false, time = settings.time } = {}) {
  const options = { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) };
  if (time === '12') options.hour12 = true;
  if (time === '24') {
    options.hourCycle = 'h23';
    options.hour = '2-digit';
  }
  return toDate(value).toLocaleTimeString(userLocale(), options);
}

// Both: 30/09/2026, 16:37.
export function formatDateTime(value, options = {}) {
  return `${formatDate(value, options)}, ${formatTime(value, options)}`;
}

// The current choice ({ date, time }), redrawing the component when it changes.
export function useDateFormat() {
  return useSyncExternalStore(subscribe, getDateSettings, getDateSettings);
}
