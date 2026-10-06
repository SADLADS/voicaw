import { describe, it, expect } from 'vitest';
import { addMonths, dayKey, defaultStart, eventsByDay, isPastDay, monthGrid, startOnDay } from './eventCalendar';
import { occurrencesBetween } from './eventRecurrence';

const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const weekly = { frequency: 2, interval: 1, by_weekday: [1], by_n_weekday: null, by_month: null, by_month_day: null };

// A repeating event as the server sends it.
function series(rule, start, { end = null, zone = 'Europe/London', ...rest } = {}) {
  return {
    id: 1, name: 'Game night', status: 'scheduled', start_time: start, end_time: end,
    recurrence: rule, timezone: zone, occurrence_start: start, duration: end != null ? end - start : null, ...rest,
  };
}

describe('occurrences of repeating events', () => {
  // Tuesday 20 October 2026, 20:00 in London (summer time).
  const start = at('2026-10-20T19:00:00Z');

  it('keeps the wall-clock time across a clock change', () => {
    const list = occurrencesBetween(series(weekly, start, { end: start + 7200 }), at('2026-10-01T00:00:00Z'), at('2026-11-08T00:00:00Z'));
    expect(list).toEqual([
      { start, end: start + 7200 },
      { start: at('2026-10-27T20:00:00Z'), end: at('2026-10-27T22:00:00Z') },
      { start: at('2026-11-03T20:00:00Z'), end: at('2026-11-03T22:00:00Z') },
    ]);
  });

  it('follows every other week, the nth weekday and yearly dates', () => {
    const from = at('2026-10-01T00:00:00Z');
    const to = at('2026-12-31T00:00:00Z');
    const fortnightly = occurrencesBetween(series({ ...weekly, interval: 2 }, start), from, to).map((o) => o.start);
    expect(fortnightly.slice(0, 3)).toEqual([start, at('2026-11-03T20:00:00Z'), at('2026-11-17T20:00:00Z')]);
    const monthly = { frequency: 1, interval: 1, by_weekday: null, by_n_weekday: [{ n: 3, day: 1 }], by_month: null, by_month_day: null };
    expect(occurrencesBetween(series(monthly, start), from, to).map((o) => o.start))
      .toEqual([start, at('2026-11-17T20:00:00Z'), at('2026-12-15T20:00:00Z')]);
    const yearly = { frequency: 0, interval: 1, by_weekday: null, by_n_weekday: null, by_month: [10], by_month_day: [20] };
    expect(occurrencesBetween(series(yearly, start), from, to).map((o) => o.start)).toEqual([start]);
    expect(occurrencesBetween(series(yearly, start), at('2027-10-01T00:00:00Z'), at('2027-11-01T00:00:00Z')).map((o) => o.start))
      .toEqual([at('2027-10-20T19:00:00Z')]);
  });

  it('shows a moved occurrence at its new time, and the rule after it', () => {
    const moved = series(weekly, at('2026-10-21T18:00:00Z'), { occurrence_start: start });
    expect(occurrencesBetween(moved, at('2026-10-19T00:00:00Z'), at('2026-10-29T00:00:00Z')).map((o) => o.start))
      .toEqual([at('2026-10-21T18:00:00Z'), at('2026-10-27T20:00:00Z')]);
  });

  it('only gives a one-off event in its own window', () => {
    const once = series(null, start);
    expect(occurrencesBetween(once, at('2026-10-01T00:00:00Z'), at('2026-11-01T00:00:00Z'))).toHaveLength(1);
    expect(occurrencesBetween(once, at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z'))).toEqual([]);
  });
});

describe('the calendar', () => {
  it('lays a month on six weeks from Monday', () => {
    const days = monthGrid('2026-10');
    expect(days).toHaveLength(42);
    expect(dayKey(days[0])).toBe('2026-09-28');
    expect(dayKey(days[41])).toBe('2026-11-08');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('puts each occurrence on its day, soonest first', () => {
    const days = monthGrid('2026-10');
    const daily = series({ frequency: 3, interval: 1, by_weekday: null, by_n_weekday: null, by_month: null, by_month_day: null }, at('2026-10-30T12:00:00Z'));
    const once = { ...series(null, at('2026-10-31T09:00:00Z')), id: 2 };
    const byDay = eventsByDay([daily, once], days);
    const total = [...byDay.values()].reduce((n, list) => n + list.length, 0);
    expect(total).toBe(10 + 1); // 30 October to 8 November, and the one-off
    const both = byDay.get(dayKey(new Date(at('2026-10-31T09:00:00Z') * 1000)));
    expect(both.map((o) => o.event.id)).toEqual([2, 1]);
  });

  it('starts a new event on a day at 18:00, never sooner than the next hour allows', () => {
    const now = new Date(2026, 9, 6, 10, 30).getTime();
    expect(startOnDay('2026-10-09', now)).toBe(Math.floor(new Date(2026, 9, 9, 18, 0).getTime() / 1000));
    const late = new Date(2026, 9, 6, 22, 30).getTime();
    expect(startOnDay('2026-10-06', late)).toBe(defaultStart(late));
    expect(isPastDay('2026-10-05', now)).toBe(true);
    expect(isPastDay('2026-10-06', now)).toBe(false);
  });
});
