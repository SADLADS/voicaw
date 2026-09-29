import { useCallback, useEffect, useRef, useState } from 'react';
import { onGuildEvent } from '../utils/ws-client';
import { fetchGuild, fetchGuilds, fetchGuildUnread } from '../services/guildService';

// The logged-in user's guilds, for the whole layout (Layout puts this in LayoutContext):
// - `guilds`: the list for the server rail ([{ id, name, owner, icon_version }]).
// - `layouts`: guilds opened so far, by id, with their `categories` and `channels`
//   (`loadGuild(id)` fetches one; websocket updates keep them current).
// - `unread`: [{ channel_id, guild_id, count }]; `refreshUnread()` refetches it.
// `activeChannelId` is the channel on screen: new messages there don't count as unread.
// `onRemoved(guildId)` runs when you leave, are removed from, or delete a guild.
export function useGuildList({ userId, activeChannelId, onRemoved }) {
  const [guilds, setGuilds] = useState([]);
  const [layouts, setLayouts] = useState({});
  const [unread, setUnread] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const active = useRef(activeChannelId);
  active.current = activeChannelId;
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;

  const refreshUnread = useCallback(async () => {
    try {
      setUnread(await fetchGuildUnread());
    } catch (err) {
      console.warn('Failed to load guild unread counts', err);
    }
  }, []);

  const upsertGuild = useCallback((guild) => {
    const summary = { id: guild.id, name: guild.name, owner: guild.owner, icon_version: guild.icon_version, created_at: guild.created_at };
    setGuilds((prev) => (prev.some((g) => g.id === guild.id)
      ? prev.map((g) => (g.id === guild.id ? summary : g))
      : [...prev, summary]));
    if (guild.categories) setLayouts((prev) => ({ ...prev, [guild.id]: guild }));
  }, []);

  const removeGuild = useCallback((guildId) => {
    setGuilds((prev) => prev.filter((g) => g.id !== guildId));
    setLayouts((prev) => {
      const { [guildId]: _removed, ...rest } = prev;
      return rest;
    });
    setUnread((prev) => prev.filter((u) => u.guild_id !== guildId));
    onRemovedRef.current?.(guildId);
  }, []);

  const loadGuild = useCallback(async (guildId) => {
    const guild = await fetchGuild(guildId);
    upsertGuild(guild);
    return guild;
  }, [upsertGuild]);

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchGuilds();
        if (!cancelled) setGuilds(list);
      } catch (err) {
        console.warn('Failed to load guilds', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    refreshUnread();
    return () => {
      cancelled = true;
    };
  }, [userId, refreshUnread]);

  useEffect(() => {
    if (!userId) return undefined;
    return onGuildEvent((event) => {
      switch (event.type) {
        case 'guild_add':
        case 'guild_update':
          upsertGuild(event.guild);
          break;
        case 'guild_remove':
          removeGuild(event.guildId);
          break;
        case 'guild_message_new': {
          const { message } = event;
          if (message.sender_id === userId || String(message.channel_id) === String(active.current)) break;
          setUnread((prev) => (prev.some((u) => u.channel_id === message.channel_id)
            ? prev.map((u) => (u.channel_id === message.channel_id ? { ...u, count: u.count + 1 } : u))
            : [...prev, { channel_id: message.channel_id, guild_id: event.guildId, count: 1 }]));
          break;
        }
        default:
      }
    });
  }, [userId, upsertGuild, removeGuild]);

  return { guilds, layouts, unread, loaded, loadGuild, upsertGuild, removeGuild, refreshUnread };
}
