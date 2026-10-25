import { useCallback, useEffect, useMemo, useRef, useState, useContext } from 'react';
import { useLocation, Outlet, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import DmSidebar from './DmSidebar';
import GuildSidebar from './guild/GuildSidebar';
import SidebarWrapper from './SidebarWrapper';
import SidebarResizer from './SidebarResizer';
import UserPanel from './UserPanel';
import VoiceBar from './voice/VoiceBar';
import StreamCorner from './voice/StreamCorner';
import StreamPopout from './voice/StreamPopout';
import { useStreamOnPage } from '../hooks/useStreamOnPage';
import { useCornerDrag } from '../hooks/useCornerDrag';
import WatchPartyPlayer from './voice/WatchPartyPlayer';
import IncomingCall from './call/IncomingCall';
import UserProfileHost from './UserProfileHost';
import BotModal from './BotModal';
import { initCalls } from '../voice/callClient';
import { initSoundboard } from '../voice/soundboard';
import { connectWebSocket, onNewDm } from '../utils/ws-client';
import { isOfflineMode } from '../utils/offlineMode';
import api from '../utils/api';
import { fetchUsersList } from '../services/dmService';
import 'highlight.js/styles/atom-one-dark.css';
import '../assets/css/hljs-light.css';
import { ChannelMentionContext, ConfigContext, InteractionContext, LayoutContext } from '../contexts';
import { ensureSubscription, getPushStatus } from '../services/pushService';
import { useGuildList } from '../hooks/useGuildList';
import { useGroupList } from '../hooks/useGroupList';
import { useBotDmList } from '../hooks/useBotDmList';
import { useConversationSettings } from '../hooks/useConversationSettings';
import { usePreferencesSync } from '../hooks/usePreferencesSync';
import { useBlocksSync } from '../hooks/useBlocksSync';
import { useAdminAlertsSync } from '../hooks/useAdminAlerts';
import { useFriendsSync } from '../hooks/useFriendsSync';
import { useFriends } from '../utils/friends';
import { useDictionarySync } from '../hooks/useDictionarySync';
import { useEmojiUsageSync } from '../hooks/useEmojiUsageSync';
import { useSwipePanes } from '../hooks/useSwipePanes';
import { useDesktopApp } from '../hooks/useDesktopApp';
import { useGameOverlay } from '../hooks/useGameOverlay';
import { useAndroidApp } from '../hooks/useAndroidApp';
import { useFaviconDot } from '../hooks/useFaviconDot';
import { useRouteTitle } from '../hooks/usePageTitle';
import { unreadChats } from '../utils/latestUnread';
import { CustomEmojiContext } from '../emoji/customEmojiContext';
import { clearProfiles, isBot, mergeProfiles } from '../utils/profiles';
import { setPersonMessenger } from '../utils/personMenu';
import { startBotDm } from '../services/botDmService';
import { forgetChat, rememberChat } from '../utils/lastChat';
import { clampSidebarWidth, loadSidebarWidth, onSidebarWidthStorage, saveSidebarWidth } from '../utils/sidebarWidth';

// The router's path as the address bar has it now (hash URLs for a page opened from a file,
// see App.jsx), which can be ahead of the rendered `location`.
function currentPath() {
  const { protocol, hash, pathname } = window.location;
  return protocol === 'file:' ? hash.slice(1).split('?')[0] || '/' : pathname;
}

export default function Layout({ user, onLogout }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [hasUnreadDms, setHasUnreadDms] = useState(false);
  const [unreadDms, setUnreadDms] = useState([]);
  
  const [users, setUsers] = useState([]);
  const [errorUsers, setErrorUsers] = useState(null);
  
  // Check if we are on the DM page
  const isDmPage = location.pathname.startsWith('/dm');
  const streamOnPage = useStreamOnPage();
  // A guild page: /guild/:guildId[/:channelId].
  const guildMatch = /^\/guild\/(\d+)(?:\/(\d+))?/.exec(location.pathname);
  const guildId = guildMatch?.[1];
  // A thread open beside the channel (?thread=<id>).
  const threadId = guildMatch ? new URLSearchParams(location.search).get('thread') : null;
  // Settings: its column of pages goes beside the rail (Settings puts it into `settingsNavSlot`
  // with a portal), so the user panel sits under it like on other pages; on a phone that's the
  // list pane, under the page.
  const { isMobile } = useContext(InteractionContext);
  const settingsColumn = location.pathname.startsWith('/settings');
  const [settingsNavSlot, setSettingsNavSlot] = useState(null);
  // On a computer the column beside the rail (DM list, channel list, Settings) is one width,
  // dragged by its edge and remembered per device (utils/sidebarWidth.js). Phones: full width.
  const hasColumn = isDmPage || Boolean(guildId) || settingsColumn;
  const [savedSidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  useEffect(() => onSidebarWidthStorage(setSidebarWidth), []);
  const changeSidebarWidth = useCallback((width) => {
    setSidebarWidth(width);
    saveSidebarWidth(width);
  }, []);
  // The width saved on a wide window can be too much for a narrow one: what's shown is fitted
  // to the window (the page keeps its minimum), and the saved width comes back when it's wide
  // again.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const sidebarWidth = clampSidebarWidth(savedSidebarWidth, windowWidth);

  // Phone: the list and the chat (or Settings' column and page) are two panes, swiped between
  // (hooks/useSwipePanes.js). /settings alone opens on the list (My Account behind it).
  const slidey = isMobile && (isDmPage || Boolean(guildId) || settingsColumn);
  const wrapperRef = useRef(null);
  const listPaneRef = useRef(null);
  const contentPaneRef = useRef(null);
  const scrimRef = useRef(null);
  useSwipePanes({ enabled: slidey, opensOnList: location.pathname === '/settings', wrapperRef, listRef: listPaneRef, contentRef: contentPaneRef, scrimRef });

  // The corner players, dragged to any corner (bottom right, on a phone top right, until then).
  // While a page shows a stream, a bottom corner moves to the top on the same side, clear of
  // the stream's bar and the call's buttons.
  const pip = useCornerDrag(isMobile ? 'top-right' : 'bottom-right', contentPaneRef);
  const pipCorner = streamOnPage ? pip.corner.replace('bottom', 'top') : pip.corner;

  // Leaving (or being removed from) the guild on screen goes back to the DMs.
  const onGuildRemoved = useCallback((removedId) => {
    if (String(removedId) === guildId) navigate('/dm', { replace: true });
  }, [guildId, navigate]);
  const guildList = useGuildList({ userId: user?.id, activeChannelId: guildMatch?.[2] ?? null, activeThreadId: threadId, onRemoved: onGuildRemoved });
  // Group DMs: /dm/g/:groupId. Leaving (or being removed from) the one on screen goes back.
  const groupId = /^\/dm\/g\/([0-9a-f-]+)/.exec(location.pathname)?.[1] ?? null;
  const onGroupRemoved = useCallback((removedId) => {
    if (removedId === groupId) navigate('/dm', { replace: true });
  }, [groupId, navigate]);
  const groupList = useGroupList({ userId: user?.id, activeGroupId: groupId, onRemoved: onGroupRemoved });
  // Conversations with bots: /dm/b/:dmId (not end-to-end encrypted; BotDm).
  const botDmId = Number(/^\/dm\/b\/(\d+)/.exec(location.pathname)?.[1]) || null;
  const onBotDmRemoved = useCallback((removedId) => {
    if (removedId === botDmId) navigate('/dm', { replace: true });
  }, [botDmId, navigate]);
  const botDmList = useBotDmList({ userId: user?.id, activeDmId: botDmId, onRemoved: onBotDmRemoved });

  // The chat the app reopens on, and the DM page the rail goes back to (utils/lastChat.js). One
  // reopened that's gone since (a guild or group left, a conversation with a bot deleted, while
  // the app was closed or on another device) goes to the DMs.
  useEffect(() => rememberChat(location.pathname), [location.pathname]);
  const restoredChat = Boolean(location.state?.restoredChat);
  const restoredGone = restoredChat && (
    (guildId && guildList.loaded && !guildList.guilds.some((g) => String(g.id) === guildId))
    || (groupId && groupList.loaded && !groupList.groups.some((g) => g.id === groupId))
    || (botDmId && botDmList.loaded && !botDmList.botDms.some((d) => d.id === botDmId)));
  useEffect(() => {
    if (!restoredGone) return;
    forgetChat(location.pathname);
    navigate('/dm', { replace: true });
  }, [restoredGone, location.pathname, navigate]);
  // A person's menu's Message (utils/personMenu.js); a bot's conversation is its own kind.
  const upsertBotDm = useRef(botDmList.upsert);
  upsertBotDm.current = botDmList.upsert;
  useEffect(() => {
    setPersonMessenger(async (id) => {
      if (!isBot(id)) {
        navigate(`/dm/${id}`);
        return;
      }
      const dm = await startBotDm(id);
      if (dm.bot) mergeProfiles([dm.bot]);
      upsertBotDm.current?.(dm);
      navigate(`/dm/b/${dm.id}`);
    });
    return () => setPersonMessenger(null);
  }, [navigate]);
  // Your pins and mutes for DMs and groups. Muted ones don't light the rail or the desktop app.
  const conversationSettings = useConversationSettings(user?.id);
  // Your account preferences (utils/preferences), e.g. whether NSFW channels' media is blurred.
  usePreferencesSync(user?.id);
  useBlocksSync(user?.id);
  // Admins: what's waiting for them, on the Settings gear.
  useAdminAlertsSync(user?.id);
  useFriendsSync(user?.id);
  // Friend requests waiting for your answer light the rail's DM button too.
  const hasFriendRequests = useFriends().incoming.length > 0;
  useDictionarySync(user?.id);
  useEmojiUsageSync(user?.id);
  const activeGroups = useMemo(
    () => groupList.groups.map((g) => (g.unread && conversationSettings.isMuted('group', g.id) ? { ...g, unread: 0 } : g)),
    [groupList.groups, conversationSettings]
  );
  const activeBotDms = useMemo(
    () => botDmList.botDms.map((d) => (d.unread && conversationSettings.isMuted('bot', d.id) ? { ...d, unread: 0 } : d)),
    [botDmList.botDms, conversationSettings]
  );
  const hasUnreadGroups = activeGroups.some((g) => g.unread > 0 && g.id !== groupId)
    || activeBotDms.some((d) => d.unread > 0 && d.id !== botDmId);
  // Groups and bot DMs count alike for the badges below (each has `unread`).
  const activeChats = useMemo(() => [...activeGroups, ...activeBotDms], [activeGroups, activeBotDms]);
  // Muted channels and guilds don't count, unless they mention you.
  const unreadGuildIds = useMemo(() => new Set(guildList.activeUnread.map((u) => u.guild_id)), [guildList.activeUnread]);
  // Unread mentions of you, by guild id.
  const guildMentions = useMemo(() => {
    const counts = {};
    for (const u of guildList.unread) if (u.mentions) counts[u.guild_id] = (counts[u.guild_id] ?? 0) + u.mentions;
    return counts;
  }, [guildList.unread]);
  // Custom emoji for the picker and autocomplete: by guild, in rail order.
  const customEmoji = useMemo(() => {
    const guilds = guildList.guilds
      .map((guild) => ({ guild, emojis: (guildList.emojis[guild.id] ?? []).map((e) => ({ ...e, guild })) }))
      .filter((g) => g.emojis.length > 0);
    return { guilds, byId: new Map(guilds.flatMap((g) => g.emojis.map((e) => [String(e.id), e]))) };
  }, [guildList.guilds, guildList.emojis]);
  // Channels for `<#id>` mentions (ChannelMentionContext).
  const { layouts, guilds: guildSummaries, loaded: guildsLoaded, loadGuild } = guildList;
  const loadedAllGuilds = useRef(false);
  const loadAllGuilds = useCallback(() => {
    if (loadedAllGuilds.current || !guildsLoaded) return;
    loadedAllGuilds.current = true;
    for (const g of guildSummaries) {
      if (!layouts[g.id]) loadGuild(g.id).catch(() => {});
    }
  }, [guildsLoaded, guildSummaries, layouts, loadGuild]);
  const channelMentions = useMemo(() => {
    const channels = {};
    for (const guild of Object.values(layouts)) {
      for (const c of guild.channels ?? []) {
        channels[c.id] = { id: c.id, guildId: guild.id, name: c.name, type: c.type, private: Boolean(c.private) };
      }
    }
    return { channels, loadAll: loadAllGuilds };
  }, [layouts, loadAllGuilds]);

  // Everyone's profile (and yours) for names everywhere (utils/profiles), once per login; the
  // users list is fetched again on DM pages below.
  useEffect(() => {
    if (!user?.id) return undefined;
    let cancelled = false;
    Promise.all([api.get('/profile'), fetchUsersList()])
      .then(([own, everyone]) => { if (!cancelled) mergeProfiles([own.data, ...everyone]); })
      .catch((err) => console.warn('Failed to load profiles', err));
    return () => {
      cancelled = true;
      clearProfiles();
    };
  }, [user?.id]);

  useEffect(() => {
    // Only fetch users if we are on the DM page to avoid unnecessary API calls
    if (isDmPage) {
      async function fetchUsers() {
        try {
          const data = await fetchUsersList();
          setUsers(data);
          mergeProfiles(data);
          setErrorUsers(null);
          // Landing on /dm opens your latest conversation (the list is newest first), or the
          // Friends page if you have none yet. Unless the app has moved on while the list loaded
          // (a tapped notification that started it): react-router applies navigations in a
          // transition, so `location` here can still say /dm after the address has changed.
          if (location.pathname === '/dm' && currentPath() === '/dm') {
            navigate(data[0]?.last_timestamp != null ? `/dm/${data[0].id}` : '/dm/friends', { replace: true });
          }
        } catch (e) {
          setErrorUsers(e.message);
        }
      }
      fetchUsers();
    }
  }, [isDmPage, navigate, location.pathname]);


  async function fetchUnreadMessages() {
    try {
      const res = await api.get('/dm-get-unread');
      const data = res.data;
      setHasUnreadDms(data.length > 0);
      setUnreadDms(data);
    } catch (e) {
      console.log(e.message);
    }
  }

  const { vapidPublicKey } = useContext(ConfigContext);

  // Push subscriptions can change or expire, and permission may have been granted since
  // the last visit, so re-sync this device's subscription with the server on every start.
  // (Asking for permission needs a tap, so that's left to NotificationPrompt/Settings.)
  useEffect(() => {
    if (!user?.id || !vapidPublicKey || getPushStatus() !== 'granted') return;
    ensureSubscription(vapidPublicKey).catch((err) =>
      console.warn('Could not refresh push subscription:', err)
    );
  }, [user?.id, vapidPublicKey]);

  useEffect(() => {
    fetchUnreadMessages();
  }, []);


  useEffect(() => {
    // Offline mode (the offline copy, read-only): nothing to connect to; the app reloads once
    // the server is back (OfflineBanner).
    if (user?.id && !isOfflineMode()) {
      connectWebSocket(user.id);

      // Notifications come from web push (service-worker.js); here just refresh the badge, and
      // mark the conversation as started, so someone who isn't a friend joins the DM list
      // (utils/friends.js visibleInDmList) with their first message.
      const unsubscribe = onNewDm((message) => {
        fetchUnreadMessages();
        const other = message && (message.sender_id === user?.id ? message.recipient_id : message.sender_id);
        if (other != null) {
          setUsers((list) => list.map((u) => (u.id === other && u.last_timestamp == null ? { ...u, last_timestamp: message.timestamp } : u)));
        }
      });

      return () => unsubscribe();
    }
  }, [user?.id]);

  // The desktop app: notifications, the unread badge, mute/deafen shortcuts.
  const activeUnreadDms = useMemo(
    () => unreadDms.filter((u) => !conversationSettings.isMuted('dm', u.from_user_id)),
    [unreadDms, conversationSettings]
  );
  // Under the rail's DM button, each chat with unread messages (not muted, not the open one): its
  // newest sender's picture, opening it.
  const railUnreadChats = useMemo(
    () => unreadChats({
      unreadDms: activeUnreadDms,
      groups: activeGroups.filter((g) => g.id !== groupId),
      botDms: activeBotDms.filter((d) => d.id !== botDmId),
    }),
    [activeUnreadDms, activeGroups, groupId, activeBotDms, botDmId]
  );
  useDesktopApp({ navigate, unreadDms: activeUnreadDms, groups: activeChats, guildUnread: guildList.activeUnread });
  useFaviconDot({ unreadDms: activeUnreadDms, groups: activeChats, guildUnread: guildList.activeUnread });
  useRouteTitle(location.pathname, { guilds: guildList.guilds, layouts: guildList.layouts, groups: groupList.groups, botDms: botDmList.botDms, me: user });
  // The Android app: its notifications, call buttons and ongoing-call notification.
  useAndroidApp({ navigate, user, guildList, groupList });
  useGameOverlay({ user, guildList, groupList });

  // DM calls: ringing, from any page.
  useEffect(() => {
    initCalls(user?.id ? user : null);
    return () => initCalls(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Soundboard sounds played in your voice channel, from any page.
  useEffect(() => {
    initSoundboard(user?.id ? user : null);
    return () => initSoundboard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return (
    <LayoutContext.Provider value={{
      fetchUnreadMessages, hasUnreadDms, unreadDms, users, errorUsers, guildList, groupList, botDmList, conversationSettings,
      settingsNavSlot: settingsColumn ? settingsNavSlot : null,
    }}>
    <CustomEmojiContext.Provider value={customEmoji}>
    <ChannelMentionContext.Provider value={channelMentions}>
      <div
        ref={wrapperRef}
        className={`${slidey ? 'slidey ' : ''}main-wrapper d-flex`}
        style={isMobile ? undefined : { '--vc-sidebar-width': `${sidebarWidth}px` }}
      >
        {/* The user panel (and the voice bar above it, while in voice) sits under the
            conversation or channel list, or Settings' column (not on e.g. an invite page). */}
        <SidebarWrapper
          ref={listPaneRef}
          footer={hasColumn ? <><VoiceBar user={user} /><UserPanel user={user} onLogout={onLogout} /></> : null}
          resizer={hasColumn && !isMobile ? <SidebarResizer width={sidebarWidth} onChange={changeSidebarWidth} targetRef={wrapperRef} /> : null}
        >
          {/* Main sidebar always shows */}
          <Sidebar
            user={user}
            onLogout={onLogout}
            hasUnreadDms={activeUnreadDms.length > 0 || hasUnreadGroups || hasFriendRequests}
            unreadChats={railUnreadChats}
            guilds={guildList.guilds}
            unreadGuildIds={unreadGuildIds}
            guildMentions={guildMentions}
            guildVoice={guildList.guildVoice}
            onReorderGuilds={guildList.reorderGuilds}
          />

          {/* DM sidebar only shows on the /dm route */}
          {isDmPage && <DmSidebar user={user} users={users} groups={groupList.groups} botDms={botDmList.botDms} unreadDms={unreadDms} />}
          {guildId && <GuildSidebar guild={guildList.layouts[guildId]} user={user} />}
          {settingsColumn && <div className="settings-nav-slot" ref={setSettingsNavSlot} />}
        </SidebarWrapper>

        <IncomingCall user={user} />
        <StreamPopout />
        {/* Small players in a corner, on every page: a watched stream no page shows, above
            Watch Together's player while you're in a channel watching (which sits over the
            channel page's slot instead while that's on screen). Dragged to any corner. */}
        <div
          ref={pip.ref}
          className={`corner-players at-${pipCorner}${pip.dragging ? ' dragging' : ''}`}
          onPointerDown={pip.onPointerDown}
        >
          <StreamCorner />
          <WatchPartyPlayer />
        </div>
        {/* A bot's form, when one of its commands or buttons opens one. */}
        <BotModal />
        {/* Someone's full profile, from a profile card's picture or names. */}
        <UserProfileHost user={user} />

        {slidey && <div ref={scrimRef} className="pane-scrim" aria-hidden="true" />}

        {/* The main page content */}
        <div ref={contentPaneRef} className='main-content-wrapper'>
          <Outlet />
        </div>
      </div>
    </ChannelMentionContext.Provider>
    </CustomEmojiContext.Provider>
    </LayoutContext.Provider>
  );
}