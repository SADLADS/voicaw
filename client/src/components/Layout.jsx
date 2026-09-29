import { useCallback, useEffect, useMemo, useState, useContext } from 'react';
import { useLocation, Outlet, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import DmSidebar from './DmSidebar';
import GuildSidebar from './guild/GuildSidebar';
import SidebarWrapper from './SidebarWrapper';
import UserPanel from './UserPanel';
import VoiceBar from './voice/VoiceBar';
import IncomingCall from './call/IncomingCall';
import { initCalls } from '../voice/callClient';
import { connectWebSocket, onNewDm } from '../utils/ws-client';
import api from '../utils/api';
import { fetchUsersList } from '../services/dmService';
import 'highlight.js/styles/atom-one-dark.css';
import { ConfigContext, LayoutContext } from '../contexts';
import { ensureSubscription, getPushStatus } from '../services/pushService';
import { useGuildList } from '../hooks/useGuildList';
import { useGroupList } from '../hooks/useGroupList';
import { CustomEmojiContext } from '../emoji/customEmojiContext';

export default function Layout({ user, onLogout }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [hasUnreadDms, setHasUnreadDms] = useState(false);
  const [unreadDms, setUnreadDms] = useState([]);
  
  const [users, setUsers] = useState([]);
  const [errorUsers, setErrorUsers] = useState(null);
  
  // Check if we are on the DM page
  const isDmPage = location.pathname.startsWith('/dm');
  // A guild page: /guild/:guildId[/:channelId].
  const guildMatch = /^\/guild\/(\d+)(?:\/(\d+))?/.exec(location.pathname);
  const guildId = guildMatch?.[1];

  // Leaving (or being removed from) the guild on screen goes back to the DMs.
  const onGuildRemoved = useCallback((removedId) => {
    if (String(removedId) === guildId) navigate('/dm', { replace: true });
  }, [guildId, navigate]);
  const guildList = useGuildList({ userId: user?.id, activeChannelId: guildMatch?.[2] ?? null, onRemoved: onGuildRemoved });
  // Group DMs: /dm/g/:groupId. Leaving (or being removed from) the one on screen goes back.
  const groupId = /^\/dm\/g\/([0-9a-f-]+)/.exec(location.pathname)?.[1] ?? null;
  const onGroupRemoved = useCallback((removedId) => {
    if (removedId === groupId) navigate('/dm', { replace: true });
  }, [groupId, navigate]);
  const groupList = useGroupList({ userId: user?.id, activeGroupId: groupId, onRemoved: onGroupRemoved });
  const hasUnreadGroups = groupList.groups.some((g) => g.unread > 0 && g.id !== groupId);
  const unreadGuildIds = useMemo(() => new Set(guildList.unread.map((u) => u.guild_id)), [guildList.unread]);
  // Custom emoji for the picker and autocomplete: by guild, in rail order.
  const customEmoji = useMemo(() => {
    const guilds = guildList.guilds
      .map((guild) => ({ guild, emojis: (guildList.emojis[guild.id] ?? []).map((e) => ({ ...e, guild })) }))
      .filter((g) => g.emojis.length > 0);
    return { guilds, byId: new Map(guilds.flatMap((g) => g.emojis.map((e) => [String(e.id), e]))) };
  }, [guildList.guilds, guildList.emojis]);

  useEffect(() => {
    // Only fetch users if we are on the DM page to avoid unnecessary API calls
    if (isDmPage) {
      async function fetchUsers() {
        try {
          const data = await fetchUsersList();
          setUsers(data);
          setErrorUsers(null);
          // If user lands on /dm without an ID, redirect to the first user
          if (location.pathname === '/dm' && data.length > 0) {
            navigate(`/dm/${data[0].id}`, { replace: true });
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

      // Notifications come from web push (service-worker.js); here just refresh the badge.
      const unsubscribe = onNewDm(() => {
        fetchUnreadMessages();
      });

      return () => unsubscribe();
    }
  }, [user?.id]);

  // DM calls: ringing, from any page.
  useEffect(() => {
    initCalls(user?.id ? user : null);
    return () => initCalls(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return (
    <LayoutContext.Provider value={{ fetchUnreadMessages, hasUnreadDms, unreadDms, users, errorUsers, guildList, groupList }}>
    <CustomEmojiContext.Provider value={customEmoji}>
      <div className={`${isDmPage || guildId ? 'slidey' : ''} main-wrapper d-flex`}>
        {/* The user panel (and the voice bar above it, while in voice) sits under the
            conversation or channel list (not on e.g. Settings). */}
        <SidebarWrapper footer={isDmPage || guildId ? <><VoiceBar user={user} /><UserPanel user={user} /></> : null}>
          {/* Main sidebar always shows */}
          <Sidebar
            user={user}
            onLogout={onLogout}
            hasUnreadDms={hasUnreadDms || hasUnreadGroups}
            guilds={guildList.guilds}
            unreadGuildIds={unreadGuildIds}
            onReorderGuilds={guildList.reorderGuilds}
          />

          {/* DM sidebar only shows on the /dm route */}
          {isDmPage && <DmSidebar user={user} users={users} groups={groupList.groups} unreadDms={unreadDms} />}
          {guildId && <GuildSidebar guild={guildList.layouts[guildId]} user={user} />}
        </SidebarWrapper>

        <IncomingCall user={user} />

        {/* The main page content */}
        <div className='main-content-wrapper'>
          <Outlet />
        </div>
      </div>
    </CustomEmojiContext.Provider>
    </LayoutContext.Provider>
  );
}