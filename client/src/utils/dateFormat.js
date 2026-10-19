import { useSyncExternalStore } from 'react';
import { userLocale } from './locale';
import { t } from '../i18n';

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

// Making an Intl formatter is slow (toLocaleTimeString makes one per call) and every message
// shows a time, so they're kept, by locale and options.
const formatters = new Map();
function formatter(options) {
  const locale = userLocale();
  const key = `${locale}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, found);
  }
  return found;
}
const toDate = (value) => (value instanceof Date ? value : new Date(value));

// The date alone: 30/09/2026 (or as chosen).
export function formatDate(value, { date = settings.date } = {}) {
  const d = toDate(value);
  switch (date) {
    case 'dmy': return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    case 'mdy': return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
    case 'ymd': return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    default: return formatter({}).format(d);
  }
}

// The date in words, for the day dividers in chats: 11 September 2026, or September 11, 2026
// for month first (the browser's way when automatic; 2026-09-11 when that's chosen).
export function formatLongDate(value, { date = settings.date } = {}) {
  const d = toDate(value);
  const month = formatter({ month: 'long' }).format(d);
  switch (date) {
    case 'dmy': return `${d.getDate()} ${month} ${d.getFullYear()}`;
    case 'mdy': return `${month} ${d.getDate()}, ${d.getFullYear()}`;
    case 'ymd': return formatDate(d, { date });
    default: return formatter({ day: 'numeric', month: 'long', year: 'numeric' }).format(d);
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
  return formatter(options).format(toDate(value));
}

// Both: 30/09/2026, 16:37.
export function formatDateTime(value, options = {}) {
  return `${formatDate(value, options)}, ${formatTime(value, options)}`;
}

// The day of the week: Tuesday (or Tue with `short`).
export function formatWeekday(value, { short = false } = {}) {
  return formatter({ weekday: short ? 'short' : 'long' }).format(toDate(value));
}

// The day and month in words, without the year: 6 October (or October 6).
export function formatDayMonth(value, { date = settings.date } = {}) {
  const d = toDate(value);
  const month = formatter({ month: 'long' }).format(d);
  if (date === 'dmy') return `${d.getDate()} ${month}`;
  if (date === 'mdy') return `${month} ${d.getDate()}`;
  return formatter({ day: 'numeric', month: 'long' }).format(d);
}

// The month and year in words: October 2026 (the events calendar's heading).
export function formatMonthYear(value) {
  return formatter({ month: 'long', year: 'numeric' }).format(toDate(value));
}

// When something happens, in words: Tuesday 6 October 2026, 20:00 (scheduled events).
export function formatEventTime(value, options = {}) {
  return `${formatWeekday(value)} ${formatLongDate(value, options)}, ${formatTime(value, options)}`;
}

// How far off something is, in words: in 8 hours, 3 days ago (Discord's <t:…:R>; moment's
// rounding: under 45 seconds is "a few seconds", under 45 minutes minutes, under 22 hours hours,
// under 26 days days, under 11 months months, then years). `now` in ms.
export function formatRelative(value, now = Date.now()) {
  const seconds = (toDate(value).getTime() - now) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 45) return seconds >= 0 ? t('common.relativeTime.soon') : t('common.relativeTime.justNow');
  const steps = [
    ['minute', 60, 45 * 60],
    ['hour', 3600, 22 * 3600],
    ['day', 86400, 26 * 86400],
    ['month', 30.44 * 86400, 11 * 30.44 * 86400],
    ['year', 365.25 * 86400, Infinity],
  ];
  const [unit, size] = steps.find(([, , below]) => abs < below);
  const amount = Math.max(1, Math.round(abs / size)) * Math.sign(seconds);
  const key = `${userLocale()}|relative`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.RelativeTimeFormat(userLocale(), { numeric: 'always' });
    formatters.set(key, found);
  }
  return found.format(amount, unit);
}

// The current choice ({ date, time }), redrawing the component when it changes.
export function useDateFormat() {
  return useSyncExternalStore(subscribe, getDateSettings, getDateSettings);
}
