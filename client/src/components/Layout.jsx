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
import WatchPartyPlayer from './voice/WatchPartyPlayer';
import IncomingCall from './call/IncomingCall';
import BotModal from './BotModal';
import { initCalls } from '../voice/callClient';
import { connectWebSocket, onNewDm } from '../utils/ws-client';
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
import { useFriendsSync } from '../hooks/useFriendsSync';
import { useFriends } from '../utils/friends';
import { useDictionarySync } from '../hooks/useDictionarySync';
import { useSwipePanes } from '../hooks/useSwipePanes';
import { useDesktopApp } from '../hooks/useDesktopApp';
import { useAndroidApp } from '../hooks/useAndroidApp';
import { useFaviconDot } from '../hooks/useFaviconDot';
import { latestUnreadSender } from '../utils/latestUnread';
import { CustomEmojiContext } from '../emoji/customEmojiContext';
import { clearProfiles, mergeProfiles } from '../utils/profiles';
import { loadSidebarWidth, onSidebarWidthStorage, saveSidebarWidth } from '../utils/sidebarWidth';

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
  // Settings on a computer: its column of sections goes beside the rail (Settings puts it into
  // `settingsNavSlot` with a portal), so the user panel sits under it like on other pages. On a
  // phone it stays at the top of the page.
  const { isMobile } = useContext(InteractionContext);
  const settingsColumn = location.pathname.startsWith('/settings') && !isMobile;
  const [settingsNavSlot, setSettingsNavSlot] = useState(null);
  // On a computer the column beside the rail (DM list, channel list, Settings) is one width,
  // dragged by its edge and remembered per device (utils/sidebarWidth.js). Phones: full width.
  const hasColumn = isDmPage || Boolean(guildId) || settingsColumn;
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  useEffect(() => onSidebarWidthStorage(setSidebarWidth), []);
  const changeSidebarWidth = useCallback((width) => {
    setSidebarWidth(width);
    saveSidebarWidth(width);
  }, []);

  // Phone: the list and the chat are two panes, swiped between (hooks/useSwipePanes.js).
  const slidey = isMobile && (isDmPage || Boolean(guildId));
  const wrapperRef = useRef(null);
  const listPaneRef = useRef(null);
  const contentPaneRef = useRef(null);
  const scrimRef = useRef(null);
  useSwipePanes({ enabled: slidey, wrapperRef, listRef: listPaneRef, contentRef: contentPaneRef, scrimRef });

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
  // Your pins and mutes for DMs and groups. Muted ones don't light the rail or the desktop app.
  const conversationSettings = useConversationSettings(user?.id);
  // Your account preferences (utils/preferences), e.g. whether NSFW channels' media is blurred.
  usePreferencesSync(user?.id);
  useBlocksSync(user?.id);
  useFriendsSync(user?.id);
  // Friend requests waiting for your answer light the rail's DM button too.
  const hasFriendRequests = useFriends().incoming.length > 0;
  useDictionarySync(user?.id);
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
  // Muted channels don't count, unless they mention you.
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
          // Friends page if you have none yet.
          if (location.pathname === '/dm') {
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
    if (user?.id) {
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
  // The rail's DM button shows whoever sent the newest unread message (not muted, not the open group).
  const unreadFrom = useMemo(
    () => latestUnreadSender({
      unreadDms: activeUnreadDms,
      groups: [...activeGroups.filter((g) => g.id !== groupId), ...activeBotDms.filter((d) => d.id !== botDmId)],
    }),
    [activeUnreadDms, activeGroups, groupId, activeBotDms, botDmId]
  );
  useDesktopApp({ navigate, unreadDms: activeUnreadDms, groups: activeChats, guildUnread: guildList.activeUnread });
  useFaviconDot({ unreadDms: activeUnreadDms, groups: activeChats, guildUnread: guildList.activeUnread });
  // The Android app: its notifications, call buttons and ongoing-call notification.
  useAndroidApp({ navigate, user, guildList, groupList });

  // DM calls: ringing, from any page.
  useEffect(() => {
    initCalls(user?.id ? user : null);
    return () => initCalls(null);
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
            unreadFrom={unreadFrom}
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
            channel page's slot instead while that's on screen). Top right while a page shows a
            stream, so they don't cover its bar or the page's buttons under it. */}
        <div className={`corner-players${streamOnPage ? ' top' : ''}`}>
          <StreamCorner />
          <WatchPartyPlayer />
        </div>
        {/* A bot's form, when one of its commands or buttons opens one. */}
        <BotModal />

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