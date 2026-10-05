// Repeating scheduled events: Discord's recurrence rules (guild events), and when the next
// occurrence is. Occurrences fall on the event's time zone's calendar at the series' wall-clock
// time, so a weekly 20:00 event stays at 20:00 across clock changes (bots' events, made without
// a zone, are UTC).
//
// A rule is Discord's recurrence_rule without `start`, `end` and `count` (those are the event's,
// or unsupported, as in Discord): { frequency, interval, by_weekday, by_n_weekday, by_month,
// by_month_day }, and only the shapes Discord allows:
//   daily    frequency 3, interval 1, by_weekday null or a set of days (e.g. Monday to Friday)
//   weekly   frequency 2, interval 1 or 2 (every other week), by_weekday: one day
//   monthly  frequency 1, interval 1, by_n_weekday: one { n: 1–5, day } (the nth such day)
//   yearly   frequency 0, interval 1, by_month: [month 1–12], by_month_day: [day 1–31]
// Days are Discord's: 0 Monday ... 6 Sunday.

const FREQUENCY = { YEARLY: 0, MONTHLY: 1, WEEKLY: 2, DAILY: 3 };
// How many days on we look for the next occurrence (a 29 February every four years, and then some).
const MAX_SEARCH_DAYS = 9 * 366;
const DAY_MS = 86400000;

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// A known IANA time zone (or null).
function cleanTimeZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const formatters = new Map();
function formatter(zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return formatters.get(zone);
}

// The wall clock in `zone` at unix ms `ms`: { year, month (1–12), day, hour, minute, second }.
function wallClock(ms, zone) {
  const parts = Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

// How far `zone` is ahead of UTC at unix ms `ms`.
function offsetAt(ms, zone) {
  const w = wallClock(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

// The unix ms when the wall clock in `zone` shows that time (a time skipped by a clock change
// comes out an hour later; one that happens twice, the first).
function fromWallClock({ year, month, day, hour, minute, second = 0 }, zone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // The offsets either side of any clock change that day; a candidate is right if the zone
  // really has that offset then.
  const before = offsetAt(guess - DAY_MS / 2, zone);
  const after = offsetAt(guess + DAY_MS / 2, zone);
  const valid = [guess - before, guess - after].filter((t) => offsetAt(t, zone) === guess - t);
  return valid.length ? Math.min(...valid) : guess - before;
}

// Discord's day number (0 Monday ... 6 Sunday) of a calendar date.
const weekdayOf = (date) => (date.getUTCDay() + 6) % 7;

// The rule if it's one Discord allows (see the top), normalised; else null.
function cleanRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const { frequency } = rule;
  const interval = rule.interval ?? 1;
  const days = (list) => Array.isArray(list) && list.length && list.every((d) => isInt(d, 0, 6)) && new Set(list).size === list.length;
  const base = { frequency, interval, by_weekday: null, by_n_weekday: null, by_month: null, by_month_day: null };
  switch (frequency) {
    case FREQUENCY.DAILY:
      if (interval !== 1) return null;
      if (rule.by_weekday == null) return base;
      return days(rule.by_weekday) ? { ...base, by_weekday: [...rule.by_weekday].sort() } : null;
    case FREQUENCY.WEEKLY:
      if (interval !== 1 && interval !== 2) return null;
      return days(rule.by_weekday) && rule.by_weekday.length === 1 ? { ...base, by_weekday: [...rule.by_weekday] } : null;
    case FREQUENCY.MONTHLY: {
      const n = rule.by_n_weekday;
      if (interval !== 1 || !Array.isArray(n) || n.length !== 1 || !isInt(n[0]?.n, 1, 5) || !isInt(n[0]?.day, 0, 6)) return null;
      return { ...base, by_n_weekday: [{ n: n[0].n, day: n[0].day }] };
    }
    case FREQUENCY.YEARLY: {
      const [month] = rule.by_month ?? [];
      const [monthDay] = rule.by_month_day ?? [];
      if (interval !== 1 || rule.by_month?.length !== 1 || rule.by_month_day?.length !== 1) return null;
      if (!isInt(month, 1, 12) || !isInt(monthDay, 1, 31)) return null;
      if (monthDay > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return null; // no 31 April
      return { ...base, by_month: [month], by_month_day: [monthDay] };
    }
    default:
      return null;
  }
}

// Whether calendar date `date` (a UTC midnight) has an occurrence of `rule`, for a series whose
// first occurrence was on `anchor` (also a UTC midnight; for every other week).
function matches(rule, date, anchor) {
  const weekday = weekdayOf(date);
  switch (rule.frequency) {
    case FREQUENCY.DAILY:
      return !rule.by_weekday || rule.by_weekday.includes(weekday);
    case FREQUENCY.WEEKLY: {
      if (weekday !== rule.by_weekday[0]) return false;
      const weeks = Math.round((date - anchor) / (7 * DAY_MS));
      return ((weeks % rule.interval) + rule.interval) % rule.interval === 0;
    }
    case FREQUENCY.MONTHLY: {
      const [{ n, day }] = rule.by_n_weekday;
      return weekday === day && Math.ceil(date.getUTCDate() / 7) === n;
    }
    case FREQUENCY.YEARLY:
      return date.getUTCMonth() + 1 === rule.by_month[0] && date.getUTCDate() === rule.by_month_day[0];
    default:
      return false;
  }
}

// The calendar date (UTC midnight) and wall-clock time of unix s `seconds` in `zone`.
function localDate(seconds, zone) {
  const w = wallClock(seconds * 1000, zone);
  return { date: new Date(Date.UTC(w.year, w.month - 1, w.day)), time: { hour: w.hour, minute: w.minute, second: w.second } };
}

// Whether unix s `start` is itself an occurrence of `rule` (a series must start on one).
function startsOnRule(rule, start, zone) {
  const { date } = localDate(start, zone);
  return matches(rule, date, date);
}

// The occurrence after the one due at unix s `current` (the rule's time, not a moved one), for
// a series anchored at `anchor` (unix s: when it first was, or was last re-timed); unix s, or
// null if there's none within MAX_SEARCH_DAYS.
function nextOccurrence(rule, zone, current, anchor = current) {
  const { date: anchorDate, time } = localDate(anchor, zone);
  const { date: from } = localDate(current, zone);
  for (let i = 1; i <= MAX_SEARCH_DAYS; i++) {
    const date = new Date(from.getTime() + i * DAY_MS);
    if (!matches(rule, date, anchorDate)) continue;
    const at = Math.floor(fromWallClock({
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...time,
    }, zone) / 1000);
    if (at > current) return at;
  }
  return null;
}

module.exports = { FREQUENCY, cleanRule, cleanTimeZone, startsOnRule, nextOccurrence, wallClock, fromWallClock };
