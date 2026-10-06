import { dateIn, occurrencesBetween } from './eventRecurrence';

// The events calendar (events/EventCalendar.jsx): a month's weeks, the guild's events laid on
// its days (every occurrence of a repeating one), and when an event made on a day starts. Days
// are this device's, weeks start on Monday (as Discord's days do).

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

// The events on those days: Map of day key -> [{ event, start, end, allDay }], all-day ones
// first, then soonest first. A timed event shows on the day it starts, an all-day one on each
// of its dates.
export function eventsByDay(events, days) {
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
  for (const event of events) {
    if (!event.all_day) {
      for (const { start, end } of occurrencesBetween(event, from, to)) add(dayKey(new Date(start * 1000)), { event, start, end, allDay: false });
      continue;
    }
    // A day either side: its dates are its maker's, a time zone away from this device's.
    const earlier = from - (MAX_SPAN_DAYS + 1) * 86400;
    const later = to + 86400;
    for (const { start, end } of occurrencesBetween(event, earlier, from - 86400).concat(occurrencesBetween(event, from - 86400, later))) {
      const { first, last } = allDayDates(event, start, end);
      for (let d = first, n = 0; d <= last && n < MAX_SPAN_DAYS; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), n++) {
        add(dayKey(d), { event, start, end, allDay: true });
      }
    }
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.event.id - b.event.id);
  }
  return byDay;
}

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
