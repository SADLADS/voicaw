import { dateIn, occurrencesBetween, occurrenceView, pastView } from './eventRecurrence';

// The events calendar (events/EventCalendar.jsx): a month's weeks, the guild's events laid on
// its days (every occurrence of a repeating one, and what took place: the history), and when
// an event made on a day starts. Days are this device's, weeks start on Monday (as Discord's
// days do).

const pad = (n) => String(n).padStart(2, '0');

// A day's key, 'YYYY-MM-DD', on this device (also the date input's value).
export const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// A month's key, 'YYYY-MM'.
export const monthKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;

// The Date of a day or month key (midnight, the 1st for a month).
export function fromKey(key) {
  const [year, month, day = 1] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// The month `by` months on from a month key.
export function addMonths(key, by) {
  const date = fromKey(key);
  return monthKey(new Date(date.getFullYear(), date.getMonth() + by, 1));
}

// The 42 days (six weeks, Monday first) a month's page shows.
export function monthGrid(key) {
  const first = fromKey(key);
  const back = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - back + i));
}

// The first and last dates of an all-day occurrence (its maker's dates, as Dates here).
export function allDayDates(event, start, end) {
  const zone = event.timezone || 'UTC';
  const first = dateIn(start, zone);
  const last = end != null && end > start ? dateIn(end - 1, zone) : first;
  return { first, last: last < first ? first : last };
}

// Longest all-day event drawn across days, and how far back to look for one still going.
const MAX_SPAN_DAYS = 42;

// An event's occurrences starting in [from, to) as the calendar's items: { event (that
// occurrence: occurrenceView, or pastView for one that took place), start, end, original,
// past }.
function itemsOf(source, from, to) {
  if (source.past) {
    return source.start_time >= from && source.start_time < to
      ? [{ event: source, start: source.start_time, end: source.end_time, original: source.original_start ?? null, past: true }]
      : [];
  }
  return occurrencesBetween(source, from, to).map((o) => ({ ...o, event: occurrenceView(source, o.original), past: false }));
}

// The events still to come, then what took place (history: the server's records), without an
// occurrence twice.
function sourcesOf(events, history) {
  return [...events, ...history.map(pastView)];
}
const itemKey = (item) => `${item.event.id}-${item.original ?? item.start}`;

// The events on those days: Map of day key -> [{ event, start, end, allDay, original, past }],
// all-day ones first, then soonest first. A timed event shows on the day it starts, an all-day
// one on each of its dates. `history`: occurrences that took place (shown greyed).
export function eventsByDay(events, days, history = []) {
  const lastDay = days[days.length - 1];
  const from = Math.floor(days[0].getTime() / 1000);
  const to = Math.floor(new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1).getTime() / 1000);
  const shown = new Set(days.map(dayKey));
  const byDay = new Map();
  const add = (key, item) => {
    if (!shown.has(key)) return;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(item);
  };
  const seen = new Set();
  const fresh = (item) => !seen.has(itemKey(item)) && seen.add(itemKey(item));
  for (const source of sourcesOf(events, history)) {
    if (!source.all_day) {
      for (const item of itemsOf(source, from, to)) if (fresh(item)) add(dayKey(new Date(item.start * 1000)), { ...item, allDay: false });
      continue;
    }
    // A day either side: its dates are its maker's, a time zone away from this device's.
    const earlier = from - (MAX_SPAN_DAYS + 1) * 86400;
    const later = to + 86400;
    for (const item of itemsOf(source, earlier, from - 86400).concat(itemsOf(source, from - 86400, later))) {
      if (!fresh(item)) continue;
      const { first, last } = allDayDates(source, item.start, item.end);
      for (let d = first, n = 0; d <= last && n < MAX_SPAN_DAYS; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), n++) {
        add(dayKey(d), { ...item, allDay: true });
      }
    }
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.event.id - b.event.id);
  }
  return byDay;
}

// Opens a calendar item's occurrence with `onOpenEvent(id, original, past)`: its event, its
// original start, and the record if it took place.
export const openItem = (onOpenEvent, item) => onOpenEvent(item.event.id, item.original ?? null, item.past ? item.event : null);

// The next whole hour, an hour from now at the earliest: where a new event starts.
export function defaultStart(now = Date.now()) {
  const d = new Date(now + 3600 * 1000);
  d.setMinutes(0, 0, 0);
  if (d.getTime() < now + 3600 * 1000) d.setHours(d.getHours() + 1);
  return Math.floor(d.getTime() / 1000);
}

// Where an event made on a day of the calendar starts: 18:00 that day, or defaultStart if
// that's sooner than it allows.
export function startOnDay(key, now = Date.now()) {
  const evening = fromKey(key);
  evening.setHours(18, 0, 0, 0);
  return Math.max(Math.floor(evening.getTime() / 1000), defaultStart(now));
}

// Whether a day is over (no new events on it).
export function isPastDay(key, now = Date.now()) {
  return key < dayKey(new Date(now));
}

// An all-day event from date input values (start, last day; 'YYYY-MM-DD'): { startTime, endTime },
// unix s of this device's midnights, the end the one after the last day (null if empty).
export function allDayTimes(startDate, endDate) {
  if (!startDate) return { startTime: null, endTime: null };
  const first = fromKey(startDate);
  const last = endDate && endDate >= startDate ? fromKey(endDate) : first;
  const after = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  return { startTime: Math.floor(first.getTime() / 1000), endTime: Math.floor(after.getTime() / 1000) };
}

// An all-day occurrence as date input values: { start, end } (its first and last days).
export function allDayInputs(event, start = event.start_time, end = event.end_time) {
  const { first, last } = allDayDates(event, start, end);
  return { start: dayKey(first), end: dayKey(last) };
}

// The day `by` days on from a day key.
export function addDays(key, by) {
  const date = fromKey(key);
  return dayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + by));
}

// The seven days (Monday first) of the week a day is in.
export function weekDays(key) {
  const date = fromKey(key);
  const back = (date.getDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - back + i));
}

// How long an event without an end is drawn on the week (it has no length of its own), and the
// shortest block drawn, so a short event can still be read and clicked (minutes).
const NO_END_MINUTES = 60;
const MIN_BLOCK_MINUTES = 30;

// Minutes since this device's midnight (a clock change's day still runs 0 to 1440).
const minuteOfDay = (date) => date.getHours() * 60 + date.getMinutes();

// The timed events of a week (and what took place, `history`), as blocks on its days' hours:
// Map of day key -> [{ event, start, end, original, past, top, bottom, lane, lanes }], top and
// bottom in minutes of that day (0–1440). One running past midnight is a block on each day it
// covers. Blocks that overlap sit side by side: each gets a lane of the `lanes` its group of
// overlapping ones needs.
export function weekBlocks(events, days, history = []) {
  const lastDay = days[days.length - 1];
  const from = Math.floor(days[0].getTime() / 1000);
  const to = Math.floor(new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1).getTime() / 1000);
  const byDay = new Map(days.map((date) => [dayKey(date), []]));
  const seen = new Set();
  for (const source of sourcesOf(events, history)) {
    if (source.all_day) continue;
    // From earlier too, for one that began before the week and is still going.
    for (const item of itemsOf(source, from - MAX_SPAN_DAYS * 86400, to)) {
      if (seen.has(itemKey(item))) continue;
      seen.add(itemKey(item));
      const { start, end } = item;
      const until = end != null && end > start ? end : start + NO_END_MINUTES * 60;
      if (until <= from) continue;
      for (let i = 0; i < days.length; i++) {
        const dayStart = Math.floor(days[i].getTime() / 1000);
        const next = days[i + 1] ?? new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1);
        const dayEnd = Math.floor(next.getTime() / 1000);
        if (start >= dayEnd || until <= dayStart) continue;
        const top = start <= dayStart ? 0 : minuteOfDay(new Date(start * 1000));
        const bottom = until >= dayEnd ? 1440 : minuteOfDay(new Date(until * 1000));
        byDay.get(dayKey(days[i])).push({ ...item, top, bottom: Math.min(1440, Math.max(bottom, top + MIN_BLOCK_MINUTES)) });
      }
    }
  }
  for (const blocks of byDay.values()) {
    blocks.sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.event.id - b.event.id);
    let group = [];
    let groupEnd = -1;
    const close = () => {
      const lanes = Math.max(0, ...group.map((block) => block.lane)) + 1;
      for (const block of group) block.lanes = lanes;
    };
    for (const block of blocks) {
      if (block.top >= groupEnd && group.length) {
        close();
        group = [];
      }
      const taken = new Set(group.filter((other) => other.bottom > block.top).map((other) => other.lane));
      let lane = 0;
      while (taken.has(lane)) lane++;
      block.lane = lane;
      group.push(block);
      groupEnd = group.length === 1 ? block.bottom : Math.max(groupEnd, block.bottom);
    }
    if (group.length) close();
  }
  return byDay;
}

// The all-day events of a week, by day (eventsByDay's, without the timed ones).
export function weekAllDay(events, days, history = []) {
  return eventsByDay(events.filter((event) => event.all_day), days, history.filter((record) => record.all_day));
}

// Where an event made on an hour of the week starts: that hour, or defaultStart if that's
// sooner than it allows. Null when the hour is over.
export function startAtHour(key, hour, now = Date.now()) {
  const at = fromKey(key);
  at.setHours(hour, 0, 0, 0);
  const start = Math.floor(at.getTime() / 1000);
  if ((start + 3600) * 1000 <= now) return null;
  return Math.max(start, defaultStart(now));
}
