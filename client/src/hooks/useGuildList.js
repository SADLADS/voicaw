import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onConnectionState, onGuildEvent } from '../utils/ws-client';
import { threadPermissions } from '../utils/permissions';
import { applyStreamVoiceState, removeGuildStreams, setGuildStreams, setStreamsFromLayout } from '../utils/voiceStreams';
import {
  fetchAllEmojis,
  fetchCategoryMutes,
  fetchChannelMutes,
  fetchChannelNotifications,
  fetchGuild,
  fetchGuildMutes,
  fetchGuilds,
  fetchGuildUnread,
  saveGuildOrder,
} from '../services/guildService';

// The logged-in user's guilds, for the whole layout (Layout puts this in LayoutContext):
// - `guilds`: the list for the guild rail ([{ id, name, owner, icon_version }]).
// - `layouts`: guilds opened so far, by id, with their `categories` and `channels` (a voice
//   channel's `voice`: who's in it) (`loadGuild(id)` fetches one; websocket updates keep them
//   current).
// - `guildVoice`: { [guildId]: 'self' | 'others' } for guilds with someone in a voice channel you
//   can see ('self': you're one of them, on any device), for the rail's speaker. Kept for every
//   guild (the list says who's in, `guild_voice_state` keeps it current), opened or not.
// - `unread`: [{ channel_id, guild_id, count, mentions }] (`mentions`: how many mention you);
//   `refreshUnread()` refetches it.
// - `emojis`: custom emoji by guild id ({ [guildId]: [{ id, guild_id, name, animated }] }).
// - `mutes`: your muted channels ({ [channelId]: { guildId, until } }, until: unix s or null),
//   dropped as they run out; `isMuted(channelId)`; `applyMute(event)` takes what muting
//   returned (as the `guild_channel_mute` event other devices get).
// - `guildMutes`: your muted guilds ({ [guildId]: { until } }), the same way:
//   `isGuildMuted(guildId)`, `applyGuildMute(event)` (as the `guild_mute` event). A muted
//   channel's or guild's unread messages don't count (`activeUnread`: the unread rows that do,
//   or that mention you); inside the guild its channels still show what's unread.
// - `categoryMutes`: your muted categories ({ [categoryId]: { guildId, until } }), the same way:
//   `isCategoryMuted(categoryId)`, `applyCategoryMute(event)` (as the `guild_category_mute`
//   event). Every channel in a muted category (and their threads) counts as muted: `isMuted`
//   says so too (`mutes` holds only the channel's own mute).
// - `channelLevels`: your own notification level per channel ({ [channelId]: { guildId, level } },
//   'all' | 'mentions' | 'none'; none set: the guild's); `applyChannelLevel(event)` takes what
//   setting one returned (as the `guild_channel_notify` event other devices get).
// `clearUnread(channelId)` drops a channel's unread row (after Mark As Read).
// `reorderGuilds(ids)` saves a new rail order (top first); other devices follow.
// `activeChannelId` is the channel on screen, `activeThreadId` a thread open beside it: new
// messages there don't count as unread. A layout's `threads` are the active threads you can see
// (with `joined`; only joined ones count as unread), kept current by the thread events.
// `onRemoved(guildId)` runs when you leave, are removed from, or delete a guild.
// Who's sharing their screen in voice (utils/voiceStreams.js) is kept from the same list,
// layouts and events.
const summaryOf = (guild) => ({ id: guild.id, name: guild.name, owner: guild.owner, icon_version: guild.icon_version, created_at: guild.created_at });

// Who's in a layout's voice channels, { [channelId]: [userId] } (the occupied ones).
const voiceOfLayout = (guild) => Object.fromEntries(
  guild.channels.filter((c) => c.voice?.length).map((c) => [c.id, c.voice.map((s) => s.user_id)])
);

export function useGuildList({ userId, activeChannelId, activeThreadId = null, onRemoved }) {
  const [guilds, setGuilds] = useState([]);
  const [layouts, setLayouts] = useState({});
  const [unread, setUnread] = useState([]);
  const [emojis, setEmojis] = useState({});
  const [mutes, setMutes] = useState({});
  const [guildMutes, setGuildMutes] = useState({});
  const [categoryMutes, setCategoryMutes] = useState({});
  const [channelLevels, setChannelLevels] = useState({});
  // { [guildId]: { [channelId]: [userId] } }: who's in voice, in every guild.
  const [voice, setVoice] = useState({});
  const [loaded, setLoaded] = useState(false);

  const active = useRef(activeChannelId);
  active.current = activeChannelId;
  const activeThread = useRef(activeThreadId);
  activeThread.current = activeThreadId;
  const isOnScreen = (channelId) => [active.current, activeThread.current].some((id) => id != null && String(id) === String(channelId));
  const layoutsRef = useRef(layouts);
  layoutsRef.current = layouts;
  // A thread you can see but haven't joined (its messages aren't unread for you).
  const isUnjoinedThread = (guildId, channelId) => {
    const thread = layoutsRef.current[guildId]?.threads?.find((t) => t.id === channelId);
    return Boolean(thread && !thread.joined);
  };
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;

  const refreshUnread = useCallback(async () => {
    try {
      setUnread(await fetchGuildUnread());
    } catch (err) {
      console.warn('Failed to load guild unread counts', err);
    }
  }, []);

  // A live message in a channel whose category isn't known yet (its guild not opened, no unread
  // row from the server), in a guild with a muted category: the unread list is fetched again,
  // since its rows say which category they're in (one fetch for a burst of messages).
  const channelCategoriesRef = useRef({});
  const categoryMutesRef = useRef({});
  const categoryFetch = useRef(null);
  const learnCategory = useCallback((guildId, channelId) => {
    if (channelId in channelCategoriesRef.current) return;
    if (!Object.values(categoryMutesRef.current).some((m) => m.guildId === guildId)) return;
    clearTimeout(categoryFetch.current);
    categoryFetch.current = setTimeout(refreshUnread, 300);
  }, [refreshUnread]);
  useEffect(() => () => clearTimeout(categoryFetch.current), []);

  // Every guild's custom emoji.
  const loadEmojis = useCallback(async () => {
    try {
      const list = await fetchAllEmojis();
      const byGuild = {};
      for (const emoji of list) (byGuild[emoji.guild_id] ??= []).push(emoji);
      setEmojis(byGuild);
    } catch (err) {
      console.warn('Failed to load custom emoji', err);
    }
  }, []);

  const guildsRef = useRef(guilds);
  guildsRef.current = guilds;

  const upsertGuild = useCallback((guild) => {
    const summary = summaryOf(guild);
    // A guild just joined: its emoji weren't in the list loaded at login.
    if (!guildsRef.current.some((g) => g.id === guild.id)) loadEmojis();
    setGuilds((prev) => (prev.some((g) => g.id === guild.id)
      ? prev.map((g) => (g.id === guild.id ? summary : g))
      : [...prev, summary]));
    if (guild.categories) {
      setLayouts((prev) => ({ ...prev, [guild.id]: guild }));
      setVoice((prev) => ({ ...prev, [guild.id]: voiceOfLayout(guild) }));
      setStreamsFromLayout(guild);
    }
  }, [loadEmojis]);

  const removeGuild = useCallback((guildId) => {
    setGuilds((prev) => prev.filter((g) => g.id !== guildId));
    setLayouts((prev) => {
      const { [guildId]: _removed, ...rest } = prev;
      return rest;
    });
    setUnread((prev) => prev.filter((u) => u.guild_id !== guildId));
    setVoice((prev) => {
      const { [guildId]: _removed, ...rest } = prev;
      return rest;
    });
    setEmojis((prev) => {
      const { [guildId]: _removed, ...rest } = prev;
      return rest;
    });
    setMutes((prev) => Object.fromEntries(Object.entries(prev).filter(([, m]) => m.guildId !== guildId)));
    setGuildMutes((prev) => {
      const { [guildId]: _removed, ...rest } = prev;
      return rest;
    });
    setCategoryMutes((prev) => Object.fromEntries(Object.entries(prev).filter(([, m]) => m.guildId !== guildId)));
    setChannelLevels((prev) => Object.fromEntries(Object.entries(prev).filter(([, l]) => l.guildId !== guildId)));
    removeGuildStreams(guildId);
    onRemovedRef.current?.(guildId);
  }, []);

  const applyGuildMute = useCallback(({ guildId, muted, until }) => {
    setGuildMutes((prev) => {
      const { [guildId]: _old, ...rest } = prev;
      return muted ? { ...rest, [guildId]: { until: until ?? null } } : rest;
    });
  }, []);

  const applyCategoryMute = useCallback(({ categoryId, guildId, muted, until }) => {
    setCategoryMutes((prev) => {
      const { [categoryId]: _old, ...rest } = prev;
      return muted ? { ...rest, [categoryId]: { guildId, until: until ?? null } } : rest;
    });
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
      const list = await fetchGuildMutes();
      setGuildMutes(Object.fromEntries(list.map((m) => [m.guild_id, { until: m.until }])));
    } catch (err) {
      console.warn('Failed to load muted guilds', err);
    }
    try {
      const list = await fetchCategoryMutes();
      setCategoryMutes(Object.fromEntries(list.map((m) => [m.category_id, { guildId: m.guild_id, until: m.until }])));
    } catch (err) {
      console.warn('Failed to load muted categories', err);
    }
    try {
      const list = await fetchChannelNotifications();
      setChannelLevels(Object.fromEntries(list.map((l) => [l.channel_id, { guildId: l.guild_id, level: l.level }])));
    } catch (err) {
      console.warn('Failed to load channel notification settings', err);
    }
  }, []);

  // The guild list, and who's in voice in each guild.
  const loadList = useCallback(async () => {
    const list = await fetchGuilds();
    setGuilds(list.map(summaryOf));
    setVoice(Object.fromEntries(list.map((g) => [g.id, g.voice ?? {}])));
    for (const g of list) setGuildStreams(g.id, g.streams);
  }, []);

  // Mutes changed on another device, voice joins and leaves, and emoji added or removed, while
  // this one was offline are caught up on. The guilds opened so far are fetched again too: their
  // layouts are only kept current by events, so one missed (a phone's app in the background loses
  // its connection) would otherwise stay, such as people still shown in a voice channel they left.
  useEffect(() => {
    if (!userId) return undefined;
    let wasOnline = true;
    return onConnectionState((state) => {
      if (state === 'online' && !wasOnline) {
        loadMutes();
        loadEmojis();
        loadList().catch((err) => console.warn('Failed to load guilds', err));
        for (const guildId of Object.keys(layoutsRef.current)) {
          fetchGuild(guildId).then(upsertGuild, (err) => console.warn('Failed to load guild', err));
        }
      }
      wasOnline = state === 'online';
    });
  }, [userId, loadMutes, loadEmojis, loadList, upsertGuild]);

  // A mute that runs out is dropped then (channels', categories' and guilds').
  useEffect(() => {
    const ends = [...Object.values(mutes), ...Object.values(guildMutes), ...Object.values(categoryMutes)].map((m) => m.until).filter((until) => until != null);
    if (!ends.length) return undefined;
    const wait = Math.max(0, Math.min(...ends) * 1000 - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now() / 1000;
      const running = (prev) => Object.fromEntries(Object.entries(prev).filter(([, m]) => m.until == null || m.until > now));
      setMutes(running);
      setGuildMutes(running);
      setCategoryMutes(running);
    }, Math.min(wait + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [mutes, guildMutes, categoryMutes]);

  // Each channel's category ({ [channelId]: categoryId }; a thread: its channel's), from the
  // layouts opened so far and the unread rows (which carry it for guilds not opened yet).
  const channelCategories = useMemo(() => {
    const result = {};
    for (const u of unread) if ('category_id' in u) result[u.channel_id] = u.category_id;
    for (const guild of Object.values(layouts)) {
      for (const c of guild.channels ?? []) result[c.id] = c.category_id ?? null;
      for (const th of guild.threads ?? []) {
        const parent = guild.channels?.find((c) => c.id === th.parent_id);
        if (parent) result[th.id] = parent.category_id ?? null;
      }
    }
    return result;
  }, [unread, layouts]);
  channelCategoriesRef.current = channelCategories;
  categoryMutesRef.current = categoryMutes;

  const isCategoryMuted = useCallback((categoryId) => Boolean(categoryMutes[categoryId]), [categoryMutes]);
  const isMuted = useCallback(
    (channelId) => Boolean(mutes[channelId] || categoryMutes[channelCategories[channelId]]),
    [mutes, categoryMutes, channelCategories]
  );
  const isGuildMuted = useCallback((guildId) => Boolean(guildMutes[guildId]), [guildMutes]);
  const activeUnread = useMemo(
    () => unread.filter((u) => (!isMuted(u.channel_id) && !guildMutes[u.guild_id]) || u.mentions > 0),
    [unread, isMuted, guildMutes]
  );

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
        if (!cancelled) await loadList();
      } catch (err) {
        console.warn('Failed to load guilds', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    refreshUnread();
    loadMutes();
    loadEmojis();
    return () => {
      cancelled = true;
    };
  }, [userId, refreshUnread, loadMutes, loadEmojis, loadList]);

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
      loadList().catch(() => {});
    }
  }, [applyOrder, loadList]);

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
        case 'guild_mute':
          applyGuildMute(event);
          break;
        case 'guild_category_mute':
          applyCategoryMute(event);
          break;
        case 'guild_channel_notify':
          applyChannelLevel(event);
          break;
        case 'guild_voice_state':
          applyStreamVoiceState(event);
          // They're taken out of wherever they were in the guild, and put in the channel (joined).
          setVoice((prev) => {
            const channels = {};
            for (const [channelId, userIds] of Object.entries(prev[event.guildId] ?? {})) {
              const rest = userIds.filter((id) => id !== event.userId);
              if (rest.length) channels[channelId] = rest;
            }
            if (event.state) channels[event.channelId] = [...(channels[event.channelId] ?? []), event.userId];
            return { ...prev, [event.guildId]: channels };
          });
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
        // Watch Together started, changed or ended (null) in a voice channel: what the channel
        // list shows under it (voice/watchParty.js keeps the whole party).
        case 'guild_watch_party':
          setLayouts((prev) => {
            const guild = prev[event.guildId];
            if (!guild) return prev;
            const summary = event.party?.current
              ? { source: event.party.current.source, video_id: event.party.current.video_id, title: event.party.current.title, playing: event.party.playing }
              : null;
            const channels = guild.channels.map((c) => (c.id === event.channelId ? { ...c, watch_party: summary } : c));
            return { ...prev, [event.guildId]: { ...guild, channels } };
          });
          break;
        case 'guild_message_new': {
          const { message } = event;
          if (message.sender_id === userId || isOnScreen(message.channel_id) || isUnjoinedThread(event.guildId, message.channel_id)) break;
          setUnread((prev) => (prev.some((u) => u.channel_id === message.channel_id)
            ? prev.map((u) => (u.channel_id === message.channel_id ? { ...u, count: u.count + 1 } : u))
            : [...prev, { channel_id: message.channel_id, guild_id: event.guildId, count: 1, mentions: 0 }]));
          learnCategory(event.guildId, message.channel_id);
          break;
        }
        // Sent to you, right after the message itself, when it mentions you.
        case 'guild_mention':
          if (isOnScreen(event.channelId)) break;
          setUnread((prev) => (prev.some((u) => u.channel_id === event.channelId)
            ? prev.map((u) => (u.channel_id === event.channelId ? { ...u, mentions: (u.mentions ?? 0) + 1 } : u))
            : [...prev, { channel_id: event.channelId, guild_id: event.guildId, count: 1, mentions: 1 }]));
          break;
        case 'guild_thread_update':
          setLayouts((prev) => {
            const guild = prev[event.guildId];
            if (!guild) return prev;
            const { thread } = event;
            const old = guild.threads?.find((t) => t.id === thread.id);
            const rest = (guild.threads ?? []).filter((t) => t.id !== thread.id);
            // Archived threads leave the list (the channel's thread list still has them).
            if (thread.archived) return { ...prev, [event.guildId]: { ...guild, threads: rest } };
            const parent = guild.channels.find((c) => c.id === thread.parent_id);
            if (!parent) return prev;
            const entry = { ...thread, joined: old?.joined ?? false, my_permissions: threadPermissions(parent.my_permissions) };
            return { ...prev, [event.guildId]: { ...guild, threads: [entry, ...rest] } };
          });
          break;
        case 'guild_thread_delete':
          setLayouts((prev) => {
            const guild = prev[event.guildId];
            if (!guild) return prev;
            return { ...prev, [event.guildId]: { ...guild, threads: (guild.threads ?? []).filter((t) => t.id !== event.threadId) } };
          });
          setUnread((prev) => prev.filter((u) => u.channel_id !== event.threadId));
          break;
        // You joined or left a thread (on any device).
        case 'guild_thread_member':
          setLayouts((prev) => {
            const guild = prev[event.guildId];
            if (!guild?.threads?.some((t) => t.id === event.threadId)) return prev;
            const threads = guild.threads.map((t) => (t.id === event.threadId ? { ...t, joined: event.joined } : t));
            return { ...prev, [event.guildId]: { ...guild, threads } };
          });
          if (!event.joined) setUnread((prev) => prev.filter((u) => u.channel_id !== event.threadId));
          break;
        default:
      }
    });
  }, [userId, upsertGuild, removeGuild, applyOrder, applyMute, applyGuildMute, applyCategoryMute, applyChannelLevel, learnCategory]);

  const guildVoice = useMemo(() => {
    const result = {};
    for (const [guildId, channels] of Object.entries(voice)) {
      const userIds = Object.values(channels).flat();
      if (userIds.length) result[guildId] = userIds.includes(userId) ? 'self' : 'others';
    }
    return result;
  }, [voice, userId]);

  return {
    guilds, layouts, guildVoice, unread, activeUnread, emojis, mutes, isMuted, applyMute,
    guildMutes, isGuildMuted, applyGuildMute, categoryMutes, isCategoryMuted, applyCategoryMute, channelLevels, applyChannelLevel, loaded,
    loadGuild, upsertGuild, removeGuild, refreshUnread, clearUnread, reorderGuilds,
  };
}
