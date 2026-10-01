import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onConnectionState, onGuildEvent } from '../utils/ws-client';
import {
  fetchAllEmojis,
  fetchChannelMutes,
  fetchChannelNotifications,
  fetchGuild,
  fetchGuilds,
  fetchGuildUnread,
  saveGuildOrder,
} from '../services/guildService';

// The logged-in user's guilds, for the whole layout (Layout puts this in LayoutContext):
// - `guilds`: the list for the guild rail ([{ id, name, owner, icon_version }]).
// - `layouts`: guilds opened so far, by id, with their `categories` and `channels` (a voice
//   channel's `voice`: who's in it) (`loadGuild(id)` fetches one; websocket updates keep them
//   current).
// - `unread`: [{ channel_id, guild_id, count, mentions }] (`mentions`: how many mention you);
//   `refreshUnread()` refetches it.
// - `emojis`: custom emoji by guild id ({ [guildId]: [{ id, guild_id, name, animated }] }).
// - `mutes`: your muted channels ({ [channelId]: { guildId, until } }, until: unix s or null),
//   dropped as they run out; `isMuted(channelId)`; `applyMute(event)` takes what muting
//   returned (as the `guild_channel_mute` event other devices get). A muted channel's unread
//   messages don't count (`activeUnread`: the unread rows that do, or that mention you).
// - `channelLevels`: your own notification level per channel ({ [channelId]: { guildId, level } },
//   'all' | 'mentions' | 'none'; none set: the guild's); `applyChannelLevel(event)` takes what
//   setting one returned (as the `guild_channel_notify` event other devices get).
// `clearUnread(channelId)` drops a channel's unread row (after Mark As Read).
// `reorderGuilds(ids)` saves a new rail order (top first); other devices follow.
// `activeChannelId` is the channel on screen: new messages there don't count as unread.
// `onRemoved(guildId)` runs when you leave, are removed from, or delete a guild.
export function useGuildList({ userId, activeChannelId, onRemoved }) {
  const [guilds, setGuilds] = useState([]);
  const [layouts, setLayouts] = useState({});
  const [unread, setUnread] = useState([]);
  const [emojis, setEmojis] = useState({});
  const [mutes, setMutes] = useState({});
  const [channelLevels, setChannelLevels] = useState({});
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
    setMutes((prev) => Object.fromEntries(Object.entries(prev).filter(([, m]) => m.guildId !== guildId)));
    setChannelLevels((prev) => Object.fromEntries(Object.entries(prev).filter(([, l]) => l.guildId !== guildId)));
    onRemovedRef.current?.(guildId);
  }, []);

  const applyMute = useCallback(({ channelId, guildId, muted, until }) => {
    setMutes((prev) => {
      const { [channelId]: _old, ...rest } = prev;
      return muted ? { ...rest, [channelId]: { guildId, until: until ?? null } } : rest;
    });
  }, []);

  const applyChannelLevel = useCallback(({ channelId, guildId, level }) => {
    setChannelLevels((prev) => {
      const { [channelId]: _old, ...rest } = prev;
      return level ? { ...rest, [channelId]: { guildId, level } } : rest;
    });
  }, []);

  const clearUnread = useCallback((channelId) => {
    setUnread((prev) => prev.filter((u) => u.channel_id !== channelId));
  }, []);

  // Mutes and channel notification levels.
  const loadMutes = useCallback(async () => {
    try {
      const list = await fetchChannelMutes();
      setMutes(Object.fromEntries(list.map((m) => [m.channel_id, { guildId: m.guild_id, until: m.until }])));
    } catch (err) {
      console.warn('Failed to load muted channels', err);
    }
    try {
      const list = await fetchChannelNotifications();
      setChannelLevels(Object.fromEntries(list.map((l) => [l.channel_id, { guildId: l.guild_id, level: l.level }])));
    } catch (err) {
      console.warn('Failed to load channel notification settings', err);
    }
  }, []);

  // Mutes changed on another device while this one was offline are caught up on.
  useEffect(() => {
    if (!userId) return undefined;
    let wasOnline = true;
    return onConnectionState((state) => {
      if (state === 'online' && !wasOnline) loadMutes();
      wasOnline = state === 'online';
    });
  }, [userId, loadMutes]);

  // A mute that runs out is dropped then.
  useEffect(() => {
    const ends = Object.values(mutes).map((m) => m.until).filter((until) => until != null);
    if (!ends.length) return undefined;
    const wait = Math.max(0, Math.min(...ends) * 1000 - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now() / 1000;
      setMutes((prev) => Object.fromEntries(Object.entries(prev).filter(([, m]) => m.until == null || m.until > now)));
    }, Math.min(wait + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [mutes]);

  const isMuted = useCallback((channelId) => Boolean(mutes[channelId]), [mutes]);
  const activeUnread = useMemo(() => unread.filter((u) => !mutes[u.channel_id] || u.mentions > 0), [unread, mutes]);

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
    loadMutes();
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
  }, [userId, refreshUnread, loadMutes]);

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
      console.warn('Failed to save the guild order', err);
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
        case 'guild_channel_mute':
          applyMute(event);
          break;
        case 'guild_channel_notify':
          applyChannelLevel(event);
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
  }, [userId, upsertGuild, removeGuild, applyOrder, applyMute, applyChannelLevel]);

  return {
    guilds, layouts, unread, activeUnread, emojis, mutes, isMuted, applyMute, channelLevels, applyChannelLevel, loaded,
    loadGuild, upsertGuild, removeGuild, refreshUnread, clearUnread, reorderGuilds,
  };
}
