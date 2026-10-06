import { useCallback, useEffect, useRef, useState } from 'react';
import { onBotDmEvent } from '../utils/ws-client';
import { fetchBotDms } from '../services/botDmService';
import { mergeProfiles } from '../utils/profiles';

// Your conversations with bots, for the conversation list (Layout puts this in
// LayoutContext.botDmList): [{ id, bot_id, last_timestamp, unread, last_unread_sender_id,
// last_unread_timestamp }], kept current by the websocket. `activeDmId` is the one on screen
// (its new messages aren't unread). `onRemoved(dmId)` runs when one is deleted.
export function useBotDmList({ userId, activeDmId, onRemoved }) {
  const [botDms, setBotDms] = useState([]);
  const active = useRef(activeDmId);
  active.current = activeDmId;
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;
  const known = useRef(new Set());
  known.current = new Set(botDms.map((d) => d.id));

  const refresh = useCallback(async () => {
    try {
      const list = await fetchBotDms();
      // The bots' names and pictures, which the app may not have from a guild.
      mergeProfiles(list.map((d) => d.bot).filter(Boolean));
      setBotDms(list);
    } catch (err) {
      console.warn('Failed to load bot DMs', err);
    }
  }, []);

  const upsert = useCallback((entry) => {
    setBotDms((prev) => (prev.some((d) => d.id === entry.id)
      ? prev.map((d) => (d.id === entry.id ? { ...d, ...entry } : d))
      : [entry, ...prev]));
  }, []);

  useEffect(() => {
    if (!userId) return undefined;
    refresh();
    return onBotDmEvent((event) => {
      switch (event.type) {
        case 'bot_dm_message_new': {
          const { message } = event;
          // A conversation the bot just started: fetched with the rest.
          if (!known.current.has(event.dmId)) {
            refresh();
            break;
          }
          const unread = message.sender_id !== userId && event.dmId !== active.current;
          setBotDms((prev) => prev.map((d) => (d.id === event.dmId
            ? {
              ...d,
              last_timestamp: message.timestamp,
              ...(unread ? { unread: d.unread + 1, last_unread_sender_id: message.sender_id, last_unread_timestamp: message.timestamp } : {}),
            }
            : d)));
          break;
        }
        case 'bot_dm_read':
          setBotDms((prev) => prev.map((d) => (d.id === event.dmId ? { ...d, unread: 0 } : d)));
          break;
        case 'bot_dm_delete':
          setBotDms((prev) => prev.filter((d) => d.id !== event.dmId));
          onRemovedRef.current?.(event.dmId);
          break;
        default:
      }
    });
  }, [userId, refresh]);

  // Opening one reads it.
  useEffect(() => {
    if (activeDmId) setBotDms((prev) => prev.map((d) => (d.id === activeDmId && d.unread ? { ...d, unread: 0 } : d)));
  }, [activeDmId]);

  const clearUnread = useCallback((dmId) => {
    setBotDms((prev) => prev.map((d) => (d.id === dmId && d.unread ? { ...d, unread: 0 } : d)));
  }, []);

  return { botDms, refresh, upsert, clearUnread };
}
