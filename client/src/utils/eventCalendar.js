import { occurrencesBetween } from './eventRecurrence';

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

// The events on those days: Map of day key -> [{ event, start, end }], soonest first. An event
// shows on the day it starts.
export function eventsByDay(events, days) {
  const from = Math.floor(days[0].getTime() / 1000);
  const last = days[days.length - 1];
  const to = Math.floor(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime() / 1000);
  const byDay = new Map();
  for (const event of events) {
    for (const { start, end } of occurrencesBetween(event, from, to)) {
      const key = dayKey(new Date(start * 1000));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push({ event, start, end });
    }
  }
  for (const list of byDay.values()) list.sort((a, b) => a.start - b.start || a.event.id - b.event.id);
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
