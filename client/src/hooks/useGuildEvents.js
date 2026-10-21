import { useCallback, useEffect, useRef, useState } from 'react';
import { onConnectionState, onGuildEvent } from '../utils/ws-client';
import { fetchEvents } from '../services/guildService';
import { interestContinued, interestKept } from '../utils/eventDisplay';

const byStart = (a, b) => a.start_time - b.start_time || a.id - b.id;
// Gone from the list: ended or cancelled (the server deletes them).
const isOver = (event) => event.status === 'completed' || event.status === 'canceled';

// A guild's scheduled events you can see (soonest first, each with `interested`: yours), kept
// current by the websocket (guild_event_*) and loaded again when the guild changes (what you
// can see may have) or after a reconnect. `setInterested` and `upsert` (an event just saved)
// show a change at once.
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
            // "This and following" made it: your interest in the series it continues carries over.
            const old = !before && list.find((e) => e.continued_as === event.event.id);
            const interest = old ? interestContinued(old, event.event) : interestKept(before, event.event, userId);
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
              ...(event.userId === userId ? {
                interested: event.interested,
                interested_all: event.interestedAll ?? event.interested,
                my_occurrences: event.occurrences ?? {},
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

  // `state`: { interested (the current occurrence), interested_all, my_occurrences }
  // (utils/eventDisplay interestAfter).
  const setInterested = useCallback((eventId, state) => {
    setEvents((list) => list.map((e) => {
      if (e.id !== eventId) return e;
      const change = state.interested === Boolean(e.interested) ? 0 : state.interested ? 1 : -1;
      return { ...e, ...state, user_count: Math.max(0, e.user_count + change) };
    }));
  }, []);

  // An event you just saved (its socket event may come later).
  const upsert = useCallback((saved) => {
    setEvents((list) => {
      const before = list.find((e) => e.id === saved.id);
      const merged = { ...saved, ...(saved.interested != null ? {} : interestKept(before, saved, userId)) };
      return [...list.filter((e) => e.id !== saved.id), merged].sort(byStart);
    });
  }, [userId]);

  return { events, loaded, reload: load, setInterested, upsert };
}
