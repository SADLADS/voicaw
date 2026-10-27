import { useCallback, useEffect, useRef, useState } from 'react';
import { onConnectionState, onGuildEvent } from '../utils/ws-client';
import { fetchEvents } from '../services/guildService';
import { isInterested, rsvpContinued, rsvpKept } from '../utils/eventDisplay';

const byStart = (a, b) => a.start_time - b.start_time || a.id - b.id;
// Gone from the list: ended or cancelled (the server deletes them).
const isOver = (event) => event.status === 'completed' || event.status === 'canceled';

// A guild's scheduled events you can see (soonest first, each with `rsvp`: yours), kept
// current by the websocket (guild_event_*) and loaded again when the guild changes (what you
// can see may have) or after a reconnect. `setRsvp` and `upsert` (an event just saved) show a
// change at once.
export function useGuildEvents(guildId, userId) {
  const [events, setEvents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const current = useRef(guildId);

  const load = useCallback(() => {
    if (!guildId) return Promise.resolve();
    const id = guildId;
    return fetchEvents(id)
      .then((list) => {
        if (String(current.current) !== String(id)) return;
        setEvents(list.slice().sort(byStart));
        setLoaded(true);
      })
      .catch((err) => console.warn('Failed to load events', err));
  }, [guildId]);

  useEffect(() => {
    current.current = guildId;
    setEvents([]);
    setLoaded(false);
    load();
  }, [guildId, load]);

  useEffect(() => {
    let wasOnline = true;
    return onConnectionState((state) => {
      if (state === 'online' && !wasOnline) load();
      wasOnline = state === 'online';
    });
  }, [load]);

  useEffect(() => {
    if (!guildId) return undefined;
    const id = Number(guildId);
    return onGuildEvent((event) => {
      if (event.guildId !== id && event.guild?.id !== id) return;
      switch (event.type) {
        case 'guild_event_create':
        case 'guild_event_update':
          setEvents((list) => {
            const rest = list.filter((e) => e.id !== event.event.id);
            if (isOver(event.event)) return rest;
            const before = list.find((e) => e.id === event.event.id);
            // "This and following" made it: your answers to the series it continues carry over.
            const old = !before && list.find((e) => e.continued_as === event.event.id);
            const interest = old ? rsvpContinued(old, event.event) : rsvpKept(before, event.event, userId);
            return [...rest, { ...event.event, ...interest }].sort(byStart);
          });
          break;
        case 'guild_event_delete':
          setEvents((list) => list.filter((e) => e.id !== event.event.id));
          break;
        case 'guild_event_interest':
          setEvents((list) => list.map((e) => (e.id === event.eventId
            ? {
              ...e,
              user_count: event.userCount,
              rsvp_counts: event.rsvpCounts ?? e.rsvp_counts,
              waitlist: event.waitlist ?? e.waitlist,
              ...(event.userId === userId ? {
                rsvp: event.rsvp ?? null,
                rsvp_all: event.rsvpAll ?? null,
                my_rsvps: event.rsvps ?? {},
                interested: isInterested(event.rsvp),
              } : {}),
            }
            : e)));
          break;
        case 'guild_update':
          load();
          break;
        default:
      }
    });
  }, [guildId, userId, load]);

  // `state`: { rsvp (the current occurrence), rsvp_all, my_rsvps, interested }
  // (utils/eventDisplay rsvpAfter). The counts follow until the server's come (a waitlist only
  // the server works out).
  const setRsvp = useCallback((eventId, state) => {
    setEvents((list) => list.map((e) => {
      if (e.id !== eventId) return e;
      const was = e.rsvp ?? null;
      const now = state.rsvp ?? null;
      const change = isInterested(now) === isInterested(was) ? 0 : isInterested(now) ? 1 : -1;
      const counts = { going: 0, maybe: 0, declined: 0, waitlisted: 0, ...e.rsvp_counts };
      if (was !== now) {
        if (was && counts[was] > 0) counts[was]--;
        if (now) counts[now]++;
      }
      return { ...e, ...state, user_count: Math.max(0, (e.user_count ?? 0) + change), rsvp_counts: counts };
    }));
  }, []);

  // An event you just saved (its socket event may come later).
  const upsert = useCallback((saved) => {
    setEvents((list) => {
      const before = list.find((e) => e.id === saved.id);
      const merged = { ...saved, ...(saved.rsvp !== undefined ? {} : rsvpKept(before, saved, userId)) };
      return [...list.filter((e) => e.id !== saved.id), merged].sort(byStart);
    });
  }, [userId]);

  return { events, loaded, reload: load, setRsvp, upsert };
}
