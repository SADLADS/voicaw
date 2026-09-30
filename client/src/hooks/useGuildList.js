import { useCallback, useEffect, useRef, useState } from 'react';
import { onGuildEvent } from '../utils/ws-client';
import { fetchAllEmojis, fetchGuild, fetchGuilds, fetchGuildUnread, saveGuildOrder } from '../services/guildService';

// The logged-in user's guilds, for the whole layout (Layout puts this in LayoutContext):
// - `guilds`: the list for the server rail ([{ id, name, owner, icon_version }]).
// - `layouts`: guilds opened so far, by id, with their `categories` and `channels` (a voice
//   channel's `voice`: who's in it) (`loadGuild(id)` fetches one; websocket updates keep them
//   current).
// - `unread`: [{ channel_id, guild_id, count, mentions }] (`mentions`: how many mention you);
//   `refreshUnread()` refetches it.
// - `emojis`: custom emoji by guild id ({ [guildId]: [{ id, guild_id, name, animated }] }).
// `reorderGuilds(ids)` saves a new rail order (top first); other devices follow.
// `activeChannelId` is the channel on screen: new messages there don't count as unread.
// `onRemoved(guildId)` runs when you leave, are removed from, or delete a guild.
export function useGuildList({ userId, activeChannelId, onRemoved }) {
  const [guilds, setGuilds] = useState([]);
  const [layouts, setLayouts] = useState({});
  const [unread, setUnread] = useState([]);
  const [emojis, setEmojis] = useState({});
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
    setEmojis((prev) => {
      const { [guildId]: _removed, ...rest } = prev;
      return rest;
    });
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
    fetchAllEmojis()
      .then((list) => {
        if (cancelled) return;
        const byGuild = {};
        for (const emoji of list) (byGuild[emoji.guild_id] ??= []).push(emoji);
        setEmojis(byGuild);
      })
      .catch((err) => console.warn('Failed to load custom emoji', err));
    return () => {
      cancelled = true;
    };
  }, [userId, refreshUnread]);

  // Puts the guilds in `guildIds` order (any not listed keep their place at the end).
  const applyOrder = useCallback((guildIds) => {
    setGuilds((prev) => {
      const rank = new Map(guildIds.map((id, i) => [id, i]));
      return [...prev].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    });
  }, []);

  const reorderGuilds = useCallback(async (guildIds) => {
    applyOrder(guildIds);
    try {
      await saveGuildOrder(guildIds);
    } catch (err) {
      console.warn('Failed to save the server order', err);
      fetchGuilds().then(setGuilds).catch(() => {});
    }
  }, [applyOrder]);

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
        case 'guild_emojis_update':
          setEmojis((prev) => ({ ...prev, [event.guildId]: event.emojis }));
          break;
        case 'guild_order':
          applyOrder(event.guildIds);
          break;
        case 'guild_voice_state':
          setLayouts((prev) => {
            const guild = prev[event.guildId];
            if (!guild) return prev; // not opened yet: its layout will have it
            // Their entry is updated in place, added at the end (joined), or removed (left or
            // moved to another channel).
            const channels = guild.channels.map((c) => {
              const voice = c.voice ?? [];
              const here = voice.some((s) => s.user_id === event.userId);
              if (c.id === event.channelId && event.state) {
                return { ...c, voice: here ? voice.map((s) => (s.user_id === event.userId ? event.state : s)) : [...voice, event.state] };
              }
              return here ? { ...c, voice: voice.filter((s) => s.user_id !== event.userId) } : c;
            });
            return { ...prev, [event.guildId]: { ...guild, channels } };
          });
          break;
        case 'guild_message_new': {
          const { message } = event;
          if (message.sender_id === userId || String(message.channel_id) === String(active.current)) break;
          setUnread((prev) => (prev.some((u) => u.channel_id === message.channel_id)
            ? prev.map((u) => (u.channel_id === message.channel_id ? { ...u, count: u.count + 1 } : u))
            : [...prev, { channel_id: message.channel_id, guild_id: event.guildId, count: 1, mentions: 0 }]));
          break;
        }
        // Sent to you, right after the message itself, when it mentions you.
        case 'guild_mention':
          if (String(event.channelId) === String(active.current)) break;
          setUnread((prev) => (prev.some((u) => u.channel_id === event.channelId)
            ? prev.map((u) => (u.channel_id === event.channelId ? { ...u, mentions: (u.mentions ?? 0) + 1 } : u))
            : [...prev, { channel_id: event.channelId, guild_id: event.guildId, count: 1, mentions: 1 }]));
          break;
        default:
      }
    });
  }, [userId, upsertGuild, removeGuild, applyOrder]);

  return { guilds, layouts, unread, emojis, loaded, loadGuild, upsertGuild, removeGuild, refreshUnread, reorderGuilds };
}
