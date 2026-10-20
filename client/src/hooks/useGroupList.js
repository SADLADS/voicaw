import { useCallback, useEffect, useRef, useState } from 'react';
import { onGroupEvent } from '../utils/ws-client';
import { fetchGroups } from '../services/groupService';
import { groupProfileOf, openGroup } from '../services/groupKeys';
import { forgetGroup } from '../services/groupCache';
import { parseCallLog } from '../utils/callLog';

// Your group DMs, for the conversation list (Layout puts this in LayoutContext.groupList):
// [{ id, name, owner_id, members: [{ id, username }], last_timestamp, unread, last_unread_sender_id,
// last_unread_timestamp }] (the last two: the newest unread message's), kept current by
// the websocket. Names are end-to-end encrypted: each is decrypted here, on the device
// (groupKeys.groupProfileOf), and `name` is that ('' or missing: the members' names are shown),
// with `picture` ({ id, key } or null; see GroupPicture) from the same record.
// A new epoch (someone added or removed) opens the group, so the keys saved on the device
// (groupCache.js, which notifications use) stay current while the app is open.
// `activeGroupId` is the group on screen (its new messages aren't unread).
// `onRemoved(groupId)` runs when you leave or are removed. `clearUnread(groupId)` after Mark As
// Read.
export function useGroupList({ userId, activeGroupId, onRemoved }) {
  const [groups, setGroups] = useState([]);
  // The list has come from the server at least once.
  const [loaded, setLoaded] = useState(false);
  const active = useRef(activeGroupId);
  active.current = activeGroupId;
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;
  // The name version each group's shown `name` is from, so a slower decryption of an older one
  // doesn't replace a newer one.
  const shownVersion = useRef(new Map());

  const setName = useCallback((groupId, version, { name, picture }) => {
    if ((shownVersion.current.get(groupId) ?? -1) > version) return;
    shownVersion.current.set(groupId, version);
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name, picture } : g)));
  }, []);

  const decryptName = useCallback(async (summary) => {
    try {
      const profile = await groupProfileOf({ id: userId }, summary);
      if (profile) setName(summary.id, summary.name_version, profile);
    } catch (err) {
      console.warn(`Failed to read the name of group ${summary.id}`, err);
    }
  }, [userId, setName]);

  // A summary from the server, without its plaintext `name` field once names are encrypted
  // (the decrypted one, already shown, stays until the new one is read). One with a name is
  // from this device (createGroup).
  const withoutName = (summary) => {
    if (!summary.name_version || summary.name != null) return summary;
    const { name: _legacy, ...rest } = summary;
    return rest;
  };

  const refresh = useCallback(async () => {
    try {
      const list = await fetchGroups();
      setGroups((prev) => list.map((g) => {
        const shown = g.name_version ? prev.find((p) => p.id === g.id) : undefined;
        return shown?.name == null ? withoutName(g) : { ...withoutName(g), name: shown.name, picture: shown.picture };
      }));
      setLoaded(true);
      // One at a time: a group not seen on this device yet is opened (fetched and checked).
      for (const g of list) await decryptName(g);
    } catch (err) {
      console.warn('Failed to load group DMs', err);
    }
  }, [decryptName]);

  const upsert = useCallback((group) => {
    setGroups((prev) => (prev.some((g) => g.id === group.id)
      ? prev.map((g) => (g.id === group.id ? { ...g, ...withoutName(group) } : g))
      : [withoutName(group), ...prev]));
    decryptName(group);
  }, [decryptName]);

  useEffect(() => {
    if (!userId) return undefined;
    refresh();
    return onGroupEvent((event) => {
      switch (event.type) {
        case 'group_dm_add':
        case 'group_dm_update':
          upsert(event.group);
          break;
        case 'group_dm_epoch':
          openGroup({ id: userId }, event.groupId).catch((err) => console.warn('Failed to open the group', err));
          break;
        case 'group_dm_remove':
          setGroups((prev) => prev.filter((g) => g.id !== event.groupId));
          forgetGroup(event.groupId);
          onRemovedRef.current?.(event.groupId);
          break;
        case 'group_dm_message_new': {
          const { message } = event;
          // A call you were in isn't news to you (the server counts it read too).
          const call = parseCallLog(message);
          const wasInCall = call?.outcome === 'ended' && call.joined.includes(userId);
          const unread = message.sender_id !== userId && event.groupId !== active.current && !wasInCall;
          setGroups((prev) => prev.map((g) => (g.id === event.groupId
            ? {
              ...g,
              last_timestamp: message.timestamp,
              ...(unread ? { unread: g.unread + 1, last_unread_sender_id: message.sender_id, last_unread_timestamp: message.timestamp } : {}),
            }
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

  return { groups, loaded, refresh, upsert, clearUnread };
}
