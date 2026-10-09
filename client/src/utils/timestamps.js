import { useSyncExternalStore } from 'react';
import { formatDate, formatEventTime, formatLongDate, formatRelative, formatTime } from './dateFormat';

// Timestamps, written like Discord's in message text: `<t:unix>` or `<t:unix:style>`, unix in
// seconds. Each reader sees the time in their own time zone and date format, and `R` keeps
// counting ("in 8 hours" becomes "in 7 hours"). Styles (Discord's letters):
// t 18:00, T 18:00:00, d 09/10/2026, D 9 October 2026, f 9 October 2026, 18:00 (the default
// when there's none), F Friday 9 October 2026, 18:00, R in 8 hours.
export const TIMESTAMP_STYLES = ['t', 'T', 'd', 'D', 'f', 'F', 'R'];
export const DEFAULT_TIMESTAMP_STYLE = 'f';

// Fresh global regex each call (they're stateful). Discord takes up to 8.64e12 s either way
// (what a Date can hold); anything out of range stays text.
export const timestampPattern = () => /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/g;
const MAX_SECONDS = 8.64e12;
export const validTimestamp = (unix) => Number.isFinite(Number(unix)) && Math.abs(Number(unix)) <= MAX_SECONDS;

export const timestampText = (unix, style) => `<t:${unix}${style ? `:${style}` : ''}>`;

// The timestamp as its reader sees it (`now`, ms, for R).
export function formatTimestamp(unix, style, now = Date.now()) {
  const date = new Date(Number(unix) * 1000);
  switch (style) {
    case 't': return formatTime(date);
    case 'T': return formatTime(date, { seconds: true });
    case 'd': return formatDate(date);
    case 'D': return formatLongDate(date);
    case 'F': return formatEventTime(date);
    case 'R': return formatRelative(date, now);
    default: return `${formatLongDate(date)}, ${formatTime(date)}`;
  }
}

// For plain-text places (reply previews, notifications, copying): each timestamp as it reads now.
export function timestampsToText(text) {
  if (text == null) return text;
  return String(text).replace(timestampPattern(), (whole, unix, style) =>
    (validTimestamp(unix) ? formatTimestamp(unix, style) : whole));
}

// One clock for every relative timestamp on the page (and in the message box), ticking each
// second while any is shown. Returns the function that stops `listener` being called.
const listeners = new Set();
let timer = null;
export function onClockTick(listener) {
  listeners.add(listener);
  if (!timer) timer = setInterval(() => listeners.forEach((l) => l()), 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// The timestamp's text, redrawing the component only when it changes (each second's tick
// mostly gives the same words). Only R ones follow the clock.
const noSubscribe = () => () => {};
export function useTimestampText(unix, style) {
  const read = () => formatTimestamp(unix, style);
  return useSyncExternalStore(style === 'R' ? onClockTick : noSubscribe, read, read);
}
