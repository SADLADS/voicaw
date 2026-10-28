import { useCallback, useEffect, useState } from 'react';
import api from '../utils/api';
import { notificationFromPush } from '../services/pushNotifications';

// The desktop app's inbox (components/Inbox.jsx): what notified you lately (GET /inbox,
// server/inbox.js), each entry worded as its notification was, DM and group previews decrypted
// here. Loaded while `open`, again each time it opens.
// -> { entries: [{ id, unread, title, body, icon, url, timestamp, senderId }] | null (loading), failed }
export function useInbox(open) {
  const [entries, setEntries] = useState(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (isStale) => {
    try {
      const { data } = await api.get('/inbox');
      const worded = await Promise.all(data.map(async ({ id, unread, payload }) => {
        try {
          const notification = await notificationFromPush(payload);
          if (!notification) return null;
          const { title, options } = notification;
          return {
            id, unread, title, body: options.body, icon: options.icon, url: options.data.url, timestamp: options.timestamp,
            senderId: payload.senderId ?? null,
          };
        } catch {
          return null;
        }
      }));
      if (isStale()) return;
      setEntries(worded.filter(Boolean));
      setFailed(false);
    } catch {
      if (!isStale()) setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let stale = false;
    load(() => stale);
    return () => { stale = true; };
  }, [open, load]);

  return { entries, failed };
}
