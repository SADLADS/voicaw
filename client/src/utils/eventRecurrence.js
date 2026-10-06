import { formatDayMonth, formatWeekday } from './dateFormat';
import { t } from '../i18n';

// Repeating events (server/eventRecurrence.js has the rules): the choices the event editor
// offers for a start time, as Discord does, and what a rule says in words. Rules are Discord's
// ({ frequency: 0 yearly, 1 monthly, 2 weekly, 3 daily, interval, by_weekday, by_n_weekday,
// by_month, by_month_day }), days 0 Monday ... 6 Sunday, on the device's time zone.

const NONE = { by_weekday: null, by_n_weekday: null, by_month: null, by_month_day: null };
const WEEKDAYS = [0, 1, 2, 3, 4];

// Discord's day number of a Date (0 Monday ... 6 Sunday).
export const weekdayOf = (date) => (date.getDay() + 6) % 7;

// Which of its weekday in the month the date is (1–5: the 2nd Tuesday...).
const nthOf = (date) => Math.ceil(date.getDate() / 7);

// The device's time zone, which the server lays occurrences on.
export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// What the editor offers for an event starting at `date`: [{ key, rule, label }], 'none' first.
export function repeatChoices(date) {
  const weekday = weekdayOf(date);
  const day = formatWeekday(date);
  const nth = nthOf(date);
  const choices = [
    { key: 'none', rule: null, label: t('events.repeat.none') },
    { key: 'daily', rule: { frequency: 3, interval: 1, ...NONE }, label: t('events.repeat.daily') },
  ];
  if (weekday <= 4) {
    choices.push({ key: 'weekdays', rule: { frequency: 3, interval: 1, ...NONE, by_weekday: WEEKDAYS }, label: t('events.repeat.weekdays') });
  }
  choices.push(
    { key: 'weekly', rule: { frequency: 2, interval: 1, ...NONE, by_weekday: [weekday] }, label: t('events.repeat.weekly', { day }) },
    { key: 'fortnightly', rule: { frequency: 2, interval: 2, ...NONE, by_weekday: [weekday] }, label: t('events.repeat.fortnightly', { day }) },
    {
      key: 'monthly',
      rule: { frequency: 1, interval: 1, ...NONE, by_n_weekday: [{ n: nth, day: weekday }] },
      label: t('events.repeat.monthly', { nth: t(`events.repeat.nth.${nth}`), day }),
    },
    {
      key: 'yearly',
      rule: { frequency: 0, interval: 1, ...NONE, by_month: [date.getMonth() + 1], by_month_day: [date.getDate()] },
      label: t('events.repeat.yearly', { date: formatDayMonth(date) }),
    },
  );
  return choices;
}

// Which of repeatChoices a rule is ('none' for null, 'custom' for one the editor can't make,
// such as a bot's).
export function repeatKey(rule) {
  if (!rule) return 'none';
  if (rule.frequency === 3) {
    if (!rule.by_weekday) return 'daily';
    return rule.by_weekday.join() === WEEKDAYS.join() ? 'weekdays' : 'custom';
  }
  if (rule.frequency === 2) return rule.interval === 2 ? 'fortnightly' : 'weekly';
  if (rule.frequency === 1) return 'monthly';
  return 'yearly';
}

// The rule in words, for an occurrence at `date`: "Weekly on Tuesday".
export function describeRepeat(rule, date) {
  if (!rule) return null;
  const key = repeatKey(rule);
  return repeatChoices(date).find((c) => c.key === key)?.label ?? t('events.repeat.custom');
}

// The same kind of repeat for a new start date (the editor keeps "weekly" when the day
// changes); null if that date doesn't offer it (weekdays on a Saturday).
export function ruleFor(key, date) {
  return repeatChoices(date).find((c) => c.key === key)?.rule ?? null;
}

// ---- Occurrences, for the calendar ----
// The server's stepping (server/eventRecurrence.js), on the event's time zone's wall clock, so
// the calendar puts each occurrence where the server will.

const DAY_MS = 86400000;
// The longest a calendar asks about at once (a month's six weeks, and a margin).
const MAX_DAYS = 62;

const zoneFormatters = new Map();
function zoneFormatter(zone) {
  if (!zoneFormatters.has(zone)) {
    zoneFormatters.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return zoneFormatters.get(zone);
}

function wallClock(ms, zone) {
  const parts = Object.fromEntries(zoneFormatter(zone).formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

function offsetAt(ms, zone) {
  const w = wallClock(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

// Unix ms when `zone`'s clock shows that time (a skipped time an hour later, a repeated one the first).
function fromWallClock({ year, month, day, hour, minute, second = 0 }, zone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const before = offsetAt(guess - DAY_MS / 2, zone);
  const after = offsetAt(guess + DAY_MS / 2, zone);
  const valid = [guess - before, guess - after].filter((ms) => offsetAt(ms, zone) === guess - ms);
  return valid.length ? Math.min(...valid) : guess - before;
}

// The calendar date (a UTC midnight) and time of unix s `seconds` in `zone`.
function localDate(seconds, zone) {
  const w = wallClock(seconds * 1000, zone);
  return { date: new Date(Date.UTC(w.year, w.month - 1, w.day)), time: { hour: w.hour, minute: w.minute, second: w.second } };
}

// Unix s `seconds` moved `days` calendar days on in `zone`, at the same wall-clock time (an
// all-day event's end; as the server's addDays).
function addDays(seconds, days, zone) {
  const { date, time } = localDate(seconds, zone);
  const to = new Date(date.getTime() + days * DAY_MS);
  return Math.floor(fromWallClock({ year: to.getUTCFullYear(), month: to.getUTCMonth() + 1, day: to.getUTCDate(), ...time }, zone) / 1000);
}

// The date unix s `seconds` falls on in `zone`, as a Date at that day's midnight on this device
// (to show an all-day event's dates as its maker meant them, wherever it's read).
export function dateIn(seconds, zone) {
  try {
    const { date } = localDate(seconds, zone || 'UTC');
    return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  } catch {
    const d = new Date(seconds * 1000);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
}

// Whether the date (a UTC midnight) has an occurrence of a series first on `anchor` (also one).
function matches(rule, date, anchor) {
  const weekday = (date.getUTCDay() + 6) % 7;
  switch (rule.frequency) {
    case 3:
      return !rule.by_weekday || rule.by_weekday.includes(weekday);
    case 2: {
      if (weekday !== rule.by_weekday?.[0]) return false;
      const interval = rule.interval || 1;
      const weeks = Math.round((date - anchor) / (7 * DAY_MS));
      return ((weeks % interval) + interval) % interval === 0;
    }
    case 1: {
      const [{ n, day } = {}] = rule.by_n_weekday ?? [];
      return weekday === day && Math.ceil(date.getUTCDate() / 7) === n;
    }
    case 0:
      return date.getUTCMonth() + 1 === rule.by_month?.[0] && date.getUTCDate() === rule.by_month_day?.[0];
    default:
      return false;
  }
}

// When `event` happens, for the starts in [from, to) (unix s, at most MAX_DAYS apart; callers
// wanting all-day events that began before `from` ask from earlier):
// [{ start, end }] (end null without one): the current occurrence at its own, perhaps moved,
// time, then the rule's later ones.
export function occurrencesBetween(event, from, to) {
  const found = [];
  if (event.start_time >= from && event.start_time < to) found.push({ start: event.start_time, end: event.end_time ?? null });
  const rule = event.recurrence;
  if (!rule) return found;
  const zone = event.timezone || 'UTC';
  const current = event.occurrence_start ?? event.start_time;
  const duration = event.duration ?? (event.end_time != null ? event.end_time - event.start_time : null);
  // An all-day one lasts whole days (midnight stays midnight across a clock change).
  const days = event.all_day && duration != null ? Math.max(1, Math.round(duration / 86400)) : null;
  let anchor;
  let time;
  let first;
  let last;
  try {
    ({ date: anchor, time } = localDate(current, zone));
    first = Math.max(anchor.getTime() + DAY_MS, localDate(from, zone).date.getTime() - DAY_MS);
    last = Math.min(localDate(to, zone).date.getTime() + DAY_MS, first + MAX_DAYS * DAY_MS);
  } catch {
    return found; // a time zone this browser doesn't know
  }
  for (let ms = first; ms <= last; ms += DAY_MS) {
    const date = new Date(ms);
    if (!matches(rule, date, anchor)) continue;
    const at = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...time };
    const start = Math.floor(fromWallClock(at, zone) / 1000);
    if (start <= event.start_time || start < from || start >= to) continue;
    found.push({ start, end: days != null ? addDays(start, days, zone) : duration != null ? start + duration : null });
  }
  return found;
}
