import { useCallback, useEffect, useRef, useState } from 'react';
import { onGroupEvent } from '../utils/ws-client';
import { fetchGroups } from '../services/groupService';

// Your group DMs, for the conversation list (Layout puts this in LayoutContext.groupList):
// [{ id, name, owner_id, members: [{ id, username }], last_timestamp, unread }], kept current by
// the websocket. `activeGroupId` is the group on screen (its new messages aren't unread).
// `onRemoved(groupId)` runs when you leave or are removed. `clearUnread(groupId)` after Mark As
// Read.
export function useGroupList({ userId, activeGroupId, onRemoved }) {
  const [groups, setGroups] = useState([]);
  const active = useRef(activeGroupId);
  active.current = activeGroupId;
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;

  const refresh = useCallback(async () => {
    try {
      setGroups(await fetchGroups());
    } catch (err) {
      console.warn('Failed to load group DMs', err);
    }
  }, []);

  const upsert = useCallback((group) => {
    setGroups((prev) => (prev.some((g) => g.id === group.id)
      ? prev.map((g) => (g.id === group.id ? { ...g, ...group } : g))
      : [group, ...prev]));
  }, []);

  useEffect(() => {
    if (!userId) return undefined;
    refresh();
    return onGroupEvent((event) => {
      switch (event.type) {
        case 'group_dm_add':
        case 'group_dm_update':
          upsert(event.group);
          break;
        case 'group_dm_remove':
          setGroups((prev) => prev.filter((g) => g.id !== event.groupId));
          onRemovedRef.current?.(event.groupId);
          break;
        case 'group_dm_message_new': {
          const { message } = event;
          const unread = message.sender_id !== userId && event.groupId !== active.current;
          setGroups((prev) => prev.map((g) => (g.id === event.groupId
            ? { ...g, last_timestamp: message.timestamp, unread: unread ? g.unread + 1 : g.unread }
            : g)));
          break;
        }
        default:
      }
    });
  }, [userId, refresh, upsert]);

  // Opening a group reads it.
  useEffect(() => {
    if (activeGroupId) setGroups((prev) => prev.map((g) => (g.id === activeGroupId && g.unread ? { ...g, unread: 0 } : g)));
  }, [activeGroupId]);

  const clearUnread = useCallback((groupId) => {
    setGroups((prev) => prev.map((g) => (g.id === groupId && g.unread ? { ...g, unread: 0 } : g)));
  }, []);

  return { groups, refresh, upsert, clearUnread };
}
