import { useCallback, useEffect, useRef, useState } from 'react';
import { onGuildEvent } from '../utils/ws-client';
import { fetchEventHistory } from '../services/guildService';

const monthStart = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
const nextMonth = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 1);
const seconds = (date) => Math.floor(date.getTime() / 1000);
const keyOf = (record) => `${record.id}-${record.start_time}`;

// What took place in a guild's events (the server keeps a year of it), for the calendar's past
// days: `history` (occurrences, as events with status 'completed'), loaded a month at a time
// by `loadRange(from, to)` (unix s; what's in the future is skipped) as the calendar shows
// them. The month that's on is asked again when an event changes, since one may have ended.
export function useEventHistory(guildId) {
  const [history, setHistory] = useState([]);
  const months = useRef(new Set());
  const current = useRef(guildId);

  useEffect(() => {
    current.current = guildId;
    months.current = new Set();
    setHistory([]);
  }, [guildId]);

  const loadMonth = useCallback((start) => {
    const id = guildId;
    return fetchEventHistory(id, seconds(start), seconds(nextMonth(start)))
      .then((list) => {
        if (String(current.current) !== String(id)) return;
        setHistory((before) => {
          const from = seconds(start);
          const to = seconds(nextMonth(start));
          // That month's are replaced (an all-day one reaching into it is kept from its own).
          const kept = before.filter((r) => r.start_time < from || r.start_time >= to);
          const seen = new Set(kept.map(keyOf));
          return [...kept, ...list.filter((r) => !seen.has(keyOf(r)))].sort((a, b) => a.start_time - b.start_time);
        });
      })
      .catch((err) => {
        months.current.delete(seconds(start));
        console.warn('Failed to load past events', err);
      });
  }, [guildId]);

  const loadRange = useCallback((from, to) => {
    if (!guildId) return Promise.resolve();
    const until = Math.min(to, Date.now() / 1000);
    const waits = [];
    for (let month = monthStart(new Date(from * 1000)); seconds(month) < until; month = nextMonth(month)) {
      if (months.current.has(seconds(month))) continue;
      months.current.add(seconds(month));
      waits.push(loadMonth(month));
    }
    return Promise.all(waits);
  }, [guildId, loadMonth]);

  useEffect(() => {
    if (!guildId) return undefined;
    const id = Number(guildId);
    let timer = null;
    const off = onGuildEvent((event) => {
      if (event.guildId !== id || !['guild_event_update', 'guild_event_delete'].includes(event.type)) return;
      const month = monthStart(new Date());
      if (!months.current.has(seconds(month))) return;
      clearTimeout(timer);
      timer = setTimeout(() => loadMonth(month), 1000);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [guildId, loadMonth]);

  return { history, loadRange };
}
