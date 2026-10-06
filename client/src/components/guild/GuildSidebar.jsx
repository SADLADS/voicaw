import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBell,
  faBellSlash,
  faCalendarDays,
  faCalendarPlus,
  faChevronDown,
  faChevronRight,
  faClapperboard,
  faClipboardList,
  faFolderPlus,
  faGear,
  faMessage,
  faPlus,
  faRightFromBracket,
  faUserPlus,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { ConfigContext, InteractionContext, LayoutContext } from '../../contexts';
import { showContent } from '../../utils/mobilePanes';
import { groupChannels } from '../../utils/guildDisplay';
import { deleteCategory, deleteChannel, leaveGuild, moveCategory, moveChannel } from '../../services/guildService';
import { useChannelDrag } from '../../hooks/useChannelDrag';
import InviteDialog from './InviteDialog';
import ChannelDialog from './ChannelDialog';
import CategoryDialog from './CategoryDialog';
import GuildSettingsDialog from './GuildSettingsDialog';
import ConfirmDialog from './ConfirmDialog';
import NotificationDialog from './NotificationDialog';
import AuditLogDialog from './AuditLogDialog';
import ChannelMenu from './ChannelMenu';
import ContextMenu from '../ContextMenu';
import { useLongPress } from '../../hooks/useLongPress';
import CategoryMenu from './CategoryMenu';
import CloneChannelDialog from './CloneChannelDialog';
import ChannelIcon from './ChannelIcon';
import VoiceChannelMembers from './VoiceChannelMembers';
import '../../assets/css/events.css';
import EventsDialog from '../events/EventsDialog';
import EventEditor from '../events/EventEditor';
import { useGuildEvents } from '../../hooks/useGuildEvents';
import { canCreateEvents } from '../../utils/eventDisplay';
import { dayKey, monthKey } from '../../utils/eventCalendar';
import { useVoice } from '../../hooks/useVoice';
import { joinVoice } from '../../voice/voiceClient';
import { PERMISSIONS, has } from '../../utils/permissions';
import { t } from '../../i18n';

const COLLAPSED_KEY = 'collapsedCategories';

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

// The Events dialog's view on opening: the Calendar tab, this month, today.
function freshEventsView() {
  const now = new Date();
  return { tab: 'calendar', month: monthKey(now), day: dayKey(now) };
}

// The guild's column next to the guild rail (like Discord): its name, with a menu (invite,
// settings, audit log, create channel/category, leave), then its channels, grouped in collapsible
// categories. Unread channels are bold; private ones have a lock; muted ones are dimmed, with a
// crossed-out bell. Right-clicking a channel or category (touch and hold on a phone) opens its
// menu (ChannelMenu, CategoryMenu: read, mute, notifications, copy link, edit, duplicate,
// delete...). What's offered follows the member's permissions (Manage Channels: edit buttons
// on hover (on a computer; a phone has only the menu), creating, dragging channels and
// categories into a new order (useChannelDrag: on a phone, hold then move); Create Invite;
// Manage Guild, Manage Roles or Ban Members: Guild Settings; View Audit Log: the audit log).

export default function GuildSidebar({ guild, user }) {
  const { channelId } = useParams();
  // A thread open beside the channel; an event to show (`?event=<id>`: links, notifications).
  const [searchParams, setSearchParams] = useSearchParams();
  const openThreadId = searchParams.get('thread');
  // A voice channel's chat is open beside it (GuildView).
  const voiceChatOpen = searchParams.get('chat') === '1';
  const eventParam = searchParams.get('event');
  const navigate = useNavigate();
  const { guildList } = useContext(LayoutContext);
  const { isMobile } = useContext(InteractionContext);
  const { voiceEnabled } = useContext(ConfigContext);
  const voice = useVoice();
  const [menuOpen, setMenuOpen] = useState(false);
  // { type: 'invite' | 'settings' | 'audit' | 'channel' | 'category' | 'clone' | 'deleteChannel' |
  //   'deleteCategory' | 'leave' | 'events' | 'eventEditor', ...props }
  const [dialog, setDialog] = useState(null);
  // The guild's scheduled events (Calendar, above the channels).
  const guildEvents = useGuildEvents(guild?.id ?? null, user.id);
  // The Events dialog's { tab, month, day }: back to the calendar on today each time it opens.
  const [eventsView, setEventsView] = useState(freshEventsView);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  // The menu of a right-clicked or long-pressed channel or category ({ kind, id, anchor }).
  const [rowMenu, setRowMenu] = useState(null);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);
  const menuRef = useRef(null);
  const { drag, listRef, dragProps } = useChannelDrag({
    guild,
    enabled: has(guild?.my_permissions, PERMISSIONS.MANAGE_CHANNELS),
    onLayout: guildList.upsertGuild,
    save: (move) => (move.kind === 'channel'
      ? moveChannel(guild.id, move.id, { categoryId: move.categoryId, beforeId: move.beforeId })
      : moveCategory(guild.id, move.id, move.beforeId)),
    onError: (err) => {
      console.warn('Failed to move', err);
      guildList.loadGuild(guild.id).catch(() => {});
    },
    onMenu: (item, anchor) => setRowMenu({ ...item, anchor }),
  });
  // Touch and hold on the list's empty space (not a row) opens its menu on a phone.
  const listPress = useLongPress(() => setRowMenu({ kind: 'list', anchor: { left: 0, right: 0, top: 0, bottom: 0 } }), { enabled: isMobile });
  const onListTouchStart = (e) => {
    if (e.target.closest?.('[data-drag-row], .guild-channel, .guild-channel-voice')) return;
    listPress.onTouchStart?.(e);
  };
  // The row being dragged follows the pointer.
  const dragged = (kind, id) => (drag?.kind === kind && drag.id === id
    ? { className: ' dragging', style: { transform: `translateY(${drag.dy}px)` } }
    : { className: '', style: undefined });

  // An event link opens the event (and the link's ?event= goes, so closing it stays closed).
  const hasGuild = Boolean(guild);
  useEffect(() => {
    if (!hasGuild || !/^\d+$/.test(eventParam ?? '')) return;
    setDialog({ type: 'events', eventId: Number(eventParam) });
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.delete('event');
      return next;
    }, { replace: true });
  }, [hasGuild, eventParam, setSearchParams]);

  // The menu closes on any click outside it.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  if (!guild) {
    return <div id="guild-sidebar" className="guild-sidebar" aria-busy="true" />;
  }

  const isOwner = guild.owner === user.id;
  const can = (bit) => has(guild.my_permissions, bit);
  const managesChannels = can(PERMISSIONS.MANAGE_CHANNELS);
  const opensSettings = can(PERMISSIONS.MANAGE_GUILD) || can(PERMISSIONS.MANAGE_ROLES) ||
    can(PERMISSIONS.MANAGE_EMOJIS) || can(PERMISSIONS.BAN_MEMBERS);
  const guildUnread = guildList.unread.filter((u) => u.guild_id === guild.id);
  // A muted channel isn't unread (its mentions still count).
  const unreadChannels = new Set(guildUnread.filter((u) => !guildList.isMuted(u.channel_id)).map((u) => u.channel_id));
  const channelMentions = new Map(guildUnread.filter((u) => u.mentions > 0).map((u) => [u.channel_id, u.mentions]));
  const { uncategorized, categories } = groupChannels(guild);
  // The threads you've joined, under their channels (threads you haven't are in the channel's
  // thread list).
  const joinedThreads = (guild.threads ?? []).filter((th) => th.joined);
  const threadsOf = (channel) => joinedThreads.filter((th) => th.parent_id === channel.id);
  const hasUnreadThread = (channel) => threadsOf(channel).some((th) => unreadChannels.has(th.id) || channelMentions.has(th.id));
  // The row whose menu is open (gone if it was deleted meanwhile).
  const menuChannel = rowMenu?.kind === 'channel' ? guild.channels.find((c) => c.id === rowMenu.id) : null;
  const menuCategory = rowMenu?.kind === 'category' ? guild.categories.find((c) => c.id === rowMenu.id) : null;
  // The empty space's menu: making channels and categories, inviting.
  const listMenuItems = [
    ...(managesChannels ? [
      { key: 'create-channel', label: t('guilds.sidebar.createChannel'), icon: faPlus, onSelect: () => openDialog({ type: 'channel' }) },
      { key: 'create-category', label: t('guilds.sidebar.createCategory'), icon: faFolderPlus, onSelect: () => openDialog({ type: 'category' }) },
    ] : []),
    ...(can(PERMISSIONS.CREATE_INVITE) ? [{ key: 'invite', label: t('guilds.sidebar.invitePeople'), icon: faUserPlus, onSelect: () => openDialog({ type: 'invite' }) }] : []),
  ];
  const inVoice = voice.status !== 'idle' && voice.guildId === guild.id ? voice.channelId : null;
  const liveEvents = guildEvents.events.filter((e) => e.status === 'active');
  const speaking = new Set(voice.status === 'connected' ? voice.speaking : []);

  function toggleCategory(id) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Storage unavailable: it just won't be remembered.
      }
      return next;
    });
  }

  function openDialog(next) {
    setMenuOpen(false);
    setDialog(next);
  }

  const closeDialog = () => setDialog(null);

  function openEvents(eventId = null) {
    setEventsView(freshEventsView());
    openDialog({ type: 'events', eventId });
  }

  // A voice channel joins on click (desktop). On mobile a tap only opens it, and it's joined
  // from there: a stray tap shouldn't put you on a call.
  function openChannel(channel) {
    if (channel.type === 'voice' && !isMobile && voiceEnabled && has(channel.my_permissions, PERMISSIONS.CONNECT)) {
      joinVoice(guild.id, channel.id);
    }
    showContent();
  }

  // A joined thread, indented under its channel; it opens beside the channel.
  function renderThread(thread) {
    const active = String(thread.id) === openThreadId && String(thread.parent_id) === channelId;
    const unread = unreadChannels.has(thread.id) && !active;
    const mentions = active ? 0 : channelMentions.get(thread.id) ?? 0;
    return (
      <li key={`thread-${thread.id}`} className={`guild-thread${active ? ' active' : ''}${unread ? ' unread' : ''}`}>
        <Link
          to={`/guild/${guild.id}/${thread.parent_id}?thread=${thread.id}`}
          replace={isMobile}
          onClick={showContent}
          className="guild-channel-link guild-thread-link"
          aria-current={active ? 'page' : undefined}
        >
          <span className="guild-thread-branch" aria-hidden="true" />
          <span className="guild-channel-name">{thread.name}</span>
          {mentions > 0 && ' '}
          {mentions > 0 && (
            <span className="mention-badge" aria-label={t('guilds.sidebar.mentionCount', { count: mentions })}>{mentions > 99 ? '99+' : mentions}</span>
          )}
        </Link>
      </li>
    );
  }

  function renderChannel(channel) {
    const active = String(channel.id) === channelId;
    // A voice channel's messages are only seen while its chat is open.
    const reading = active && (channel.type !== 'voice' || voiceChatOpen);
    const unread = unreadChannels.has(channel.id) && !reading;
    const mentions = reading ? 0 : channelMentions.get(channel.id) ?? 0;
    const connected = channel.id === inVoice;
    const muted = guildList.isMuted(channel.id);
    const moving = dragged('channel', channel.id);
    return (
      <React.Fragment key={channel.id}>
      <li
        className={`guild-channel${active ? ' active' : ''}${unread ? ' unread' : ''}${muted ? ' muted' : ''}${connected ? ' connected' : ''}${moving.className}`}
        style={moving.style}
        data-drag-row="channel"
        data-id={channel.id}
        data-category={channel.category_id ?? ''}
        {...dragProps('channel', channel.id)}
      >
        <Link
          draggable={false}
          to={`/guild/${guild.id}/${channel.id}`}
          replace={isMobile}
          onClick={() => openChannel(channel)}
          className="guild-channel-link"
          aria-current={active ? 'page' : undefined}
        >
          <ChannelIcon channel={channel} className="guild-channel-icon" />
          <span className="guild-channel-name">{channel.name}</span>
          {muted && <FontAwesomeIcon icon={faBellSlash} className="guild-channel-muted" title={t('guilds.sidebar.muted')} aria-label={t('guilds.sidebar.muted')} />}
          {mentions > 0 && ' '}
          {mentions > 0 && (
            <span className="mention-badge" aria-label={t('guilds.sidebar.mentionCount', { count: mentions })}>{mentions > 99 ? '99+' : mentions}</span>
          )}
        </Link>
        {!isMobile && channel.type === 'voice' && (
          // Opens the chat without joining (clicking the channel joins).
          <Link
            draggable={false}
            to={`/guild/${guild.id}/${channel.id}?chat=1`}
            onClick={showContent}
            className={`guild-sidebar-icon-button guild-channel-chat-button${unread || mentions > 0 ? ' unread' : ''}`}
            aria-label={t('guilds.sidebar.openChatNamed', { name: channel.name })}
            title={t('guilds.sidebar.openChat')}
          >
            <FontAwesomeIcon icon={faMessage} />
          </Link>
        )}
        {!isMobile && (managesChannels || (['text', 'voice'].includes(channel.type) && has(channel.my_permissions, PERMISSIONS.MANAGE_WEBHOOKS))) && (
          <button
            type="button"
            className="guild-sidebar-icon-button"
            aria-label={t('guilds.sidebar.editChannelNamed', { name: channel.name })}
            title={t('guilds.sidebar.editChannel')}
            onClick={() => openDialog({ type: 'channel', channel })}
          >
            <FontAwesomeIcon icon={faGear} />
          </button>
        )}
      </li>
      {channel.watch_party && (
        <li className="guild-channel-watch" title={channel.watch_party.title ?? undefined}>
          <FontAwesomeIcon icon={faClapperboard} className="guild-channel-watch-icon" aria-hidden="true" />
          <span className="guild-channel-watch-title">
            {channel.watch_party.playing
              ? t('voice.watchParty.sidebarPlaying', { title: channel.watch_party.title ?? t('voice.watchParty.untitled') })
              : t('voice.watchParty.sidebarPaused', { title: channel.watch_party.title ?? t('voice.watchParty.untitled') })}
          </span>
        </li>
      )}
      {liveEvents.filter((e) => e.channel_id === channel.id).map((event) => (
        <li key={`event-${event.id}`} className="guild-channel-event">
          <button type="button" className="guild-channel-event-link" onClick={() => openEvents(event.id)}>
            <FontAwesomeIcon icon={faCalendarDays} className="guild-channel-event-icon" aria-hidden="true" />
            <span className="guild-channel-event-name">{t('guilds.sidebar.liveEvent', { name: event.name })}</span>
          </button>
        </li>
      ))}
      {channel.voice?.length > 0 && (
        <li className="guild-channel-voice">
          <VoiceChannelMembers members={channel.voice} speaking={channel.id === inVoice ? speaking : new Set()} inChannel={channel.id === inVoice} />
        </li>
      )}
      {threadsOf(channel).map(renderThread)}
      </React.Fragment>
    );
  }

  return (
    <div id="guild-sidebar" className="guild-sidebar">
      <div className="guild-header" ref={menuRef}>
        <button
          type="button"
          className="guild-header-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="guild-header-name">{guild.name}</span>
          <FontAwesomeIcon icon={menuOpen ? faXmark : faChevronDown} />
        </button>

        {menuOpen && (
          <div className="guild-menu" role="menu">
            {can(PERMISSIONS.CREATE_INVITE) && (
              <button type="button" role="menuitem" className="guild-menu-item accent" onClick={() => openDialog({ type: 'invite' })}>
                {t('guilds.sidebar.invitePeople')} <FontAwesomeIcon icon={faUserPlus} />
              </button>
            )}
            {opensSettings && (
              <button type="button" role="menuitem" className="guild-menu-item" onClick={() => openDialog({ type: 'settings' })}>
                {t('guilds.sidebar.guildSettings')} <FontAwesomeIcon icon={faGear} />
              </button>
            )}
            {can(PERMISSIONS.VIEW_AUDIT_LOG) && (
              <button type="button" role="menuitem" className="guild-menu-item" onClick={() => openDialog({ type: 'audit' })}>
                {t('guilds.sidebar.auditLog')} <FontAwesomeIcon icon={faClipboardList} />
              </button>
            )}
            {canCreateEvents(guild) && (
              <button type="button" role="menuitem" className="guild-menu-item" onClick={() => openDialog({ type: 'eventEditor' })}>
                {t('guilds.sidebar.createEvent')} <FontAwesomeIcon icon={faCalendarPlus} />
              </button>
            )}
            {managesChannels && (
              <>
                <button type="button" role="menuitem" className="guild-menu-item" onClick={() => openDialog({ type: 'channel' })}>
                  {t('guilds.sidebar.createChannel')} <FontAwesomeIcon icon={faPlus} />
                </button>
                <button type="button" role="menuitem" className="guild-menu-item" onClick={() => openDialog({ type: 'category' })}>
                  {t('guilds.sidebar.createCategory')} <FontAwesomeIcon icon={faFolderPlus} />
                </button>
              </>
            )}
            <button type="button" role="menuitem" className="guild-menu-item" onClick={() => openDialog({ type: 'notifications' })}>
              {t('guilds.sidebar.notificationSettings')} <FontAwesomeIcon icon={faBell} />
            </button>
            {!isOwner && (
              <>
                <div className="guild-menu-separator" />
                <button type="button" role="menuitem" className="guild-menu-item danger" onClick={() => openDialog({ type: 'leave' })}>
                  {t('guilds.sidebar.leaveGuild')} <FontAwesomeIcon icon={faRightFromBracket} />
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <nav
        className={`guild-channel-list${drag ? ' reordering' : ''}`}
        aria-label={t('guilds.sidebar.channels')}
        ref={listRef}
        // Right-click on the empty space (a row's own menu has already handled its clicks).
        onContextMenu={(e) => {
          if (e.defaultPrevented || !listMenuItems.length) return;
          if (e.target.closest('[data-drag-row], .guild-channel, .guild-channel-voice')) return;
          e.preventDefault();
          setRowMenu({ kind: 'list', anchor: { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY } });
        }}
        {...listPress}
        onTouchStart={onListTouchStart}
      >
        {drag?.lineTop != null && <div className="channel-drop-line" style={{ top: drag.lineTop }} aria-hidden="true" />}
        <button type="button" className={`guild-events-button${liveEvents.length ? ' live' : ''}`} onClick={() => openEvents()}>
          <FontAwesomeIcon icon={faCalendarDays} className="guild-channel-icon" aria-hidden="true" />
          <span className="guild-channel-name">
            {t('guilds.sidebar.calendar')}
          </span>
          {liveEvents.length > 0 && <span className="guild-events-live">{t('guilds.sidebar.eventLive')}</span>}
        </button>
        <ul>{uncategorized.map(renderChannel)}</ul>

        {categories.map((category) => {
          const isCollapsed = collapsed.has(category.id);
          // Collapsed, a category still shows the open channel, unread ones and your voice
          // channel (like Discord).
          const shown = isCollapsed
            ? category.channels.filter((c) => String(c.id) === channelId || unreadChannels.has(c.id) || channelMentions.has(c.id) || c.id === inVoice || hasUnreadThread(c))
            : category.channels;
          const moving = dragged('category', category.id);
          return (
            <div
              key={category.id}
              className={`guild-category${moving.className}`}
              style={moving.style}
              data-category-block=""
              data-id={category.id}
            >
              <div className="guild-category-header" data-drag-row="category" data-id={category.id} {...dragProps('category', category.id)}>
                <button
                  type="button"
                  className="guild-category-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleCategory(category.id)}
                >
                  <FontAwesomeIcon icon={isCollapsed ? faChevronRight : faChevronDown} className="guild-category-chevron" />
                  <span>{category.name}</span>
                </button>
                {managesChannels && !isMobile && (
                  <>
                    <button
                      type="button"
                      className="guild-sidebar-icon-button"
                      aria-label={t('guilds.sidebar.editCategoryNamed', { name: category.name })}
                      title={t('guilds.sidebar.editCategory')}
                      onClick={() => openDialog({ type: 'category', category })}
                    >
                      <FontAwesomeIcon icon={faGear} />
                    </button>
                    <button
                      type="button"
                      className="guild-sidebar-icon-button"
                      aria-label={t('guilds.sidebar.createChannelIn', { name: category.name })}
                      title={t('guilds.sidebar.createChannelShort')}
                      onClick={() => openDialog({ type: 'channel', categoryId: category.id })}
                    >
                      <FontAwesomeIcon icon={faPlus} />
                    </button>
                  </>
                )}
              </div>
              <ul>{shown.map(renderChannel)}</ul>
            </div>
          );
        })}

        {uncategorized.length === 0 && categories.length === 0 && (
          <p className="guild-sidebar-empty">{t('guilds.sidebar.noChannels')}</p>
        )}
      </nav>

      {rowMenu?.kind === 'list' && listMenuItems.length > 0 && (
        <ContextMenu
          title={guild.name}
          label={guild.name}
          items={listMenuItems}
          anchor={rowMenu.anchor}
          sheet={isMobile}
          onClose={closeRowMenu}
        />
      )}
      {menuChannel && (
        <ChannelMenu
          guild={guild}
          channel={menuChannel}
          anchor={rowMenu.anchor}
          sheet={isMobile}
          onEdit={() => openDialog({ type: 'channel', channel: menuChannel })}
          onClone={() => openDialog({ type: 'clone', channel: menuChannel })}
          onDelete={() => openDialog({ type: 'deleteChannel', channel: menuChannel })}
          onClose={closeRowMenu}
        />
      )}
      {menuCategory && (
        <CategoryMenu
          guild={guild}
          category={menuCategory}
          channels={guild.channels.filter((c) => c.category_id === menuCategory.id)}
          collapsed={collapsed.has(menuCategory.id)}
          anchor={rowMenu.anchor}
          sheet={isMobile}
          onToggle={() => toggleCategory(menuCategory.id)}
          onEdit={() => openDialog({ type: 'category', category: menuCategory })}
          onCreateChannel={() => openDialog({ type: 'channel', categoryId: menuCategory.id })}
          onDelete={() => openDialog({ type: 'deleteCategory', category: menuCategory })}
          onClose={closeRowMenu}
        />
      )}
      {dialog?.type === 'events' && (
        <EventsDialog
          guild={guild}
          user={user}
          events={guildEvents.events}
          loaded={guildEvents.loaded}
          setInterested={guildEvents.setInterested}
          eventId={dialog.eventId ?? null}
          view={eventsView}
          onView={(changes) => setEventsView((view) => ({ ...view, ...changes }))}
          onOpenEvent={(id) => setDialog({ type: 'events', eventId: id })}
          onCreate={(start = null) => setDialog({ type: 'eventEditor', start, back: true })}
          onEdit={(event, occurrence) => setDialog({ type: 'eventEditor', event, occurrence, back: true })}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'eventEditor' && (
        <EventEditor
          guild={guild}
          event={dialog.event}
          occurrence={dialog.occurrence}
          start={dialog.start ?? null}
          onSaved={(saved) => {
            guildEvents.upsert(saved);
            setDialog({ type: 'events', eventId: saved.id });
          }}
          onClose={() => (dialog.back ? setDialog({ type: 'events', eventId: dialog.event?.id ?? null }) : closeDialog())}
        />
      )}
      {dialog?.type === 'invite' && <InviteDialog guild={guild} onClose={closeDialog} />}
      {dialog?.type === 'audit' && <AuditLogDialog guild={guild} user={user} onClose={closeDialog} />}
      {dialog?.type === 'notifications' && <NotificationDialog guild={guild} onClose={closeDialog} />}
      {dialog?.type === 'settings' && <GuildSettingsDialog guild={guild} user={user} onClose={closeDialog} />}
      {dialog?.type === 'category' && <CategoryDialog guild={guild} category={dialog.category} onClose={closeDialog} />}
      {dialog?.type === 'channel' && (
        <ChannelDialog
          guild={guild}
          user={user}
          channel={dialog.channel}
          categoryId={dialog.categoryId}
          onCreated={(created) => navigate(`/guild/${guild.id}/${created.id}`)}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'clone' && (
        <CloneChannelDialog
          guild={guild}
          channel={dialog.channel}
          onCreated={(created) => navigate(`/guild/${guild.id}/${created.id}`)}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'deleteChannel' && (
        <ConfirmDialog
          title={t('guilds.sidebar.deleteChannel.title', { name: dialog.channel.name })}
          message={t(`guilds.sidebar.deleteChannel.${{ list: 'messageList', doc: 'messageDoc' }[dialog.channel.type] ?? 'messageText'}`, { name: dialog.channel.name })}
          confirmLabel={t('guilds.sidebar.deleteChannel.confirm')}
          focusConfirm
          onConfirm={async () => {
            await deleteChannel(guild.id, dialog.channel.id);
            if (String(dialog.channel.id) === channelId) navigate(`/guild/${guild.id}`, { replace: true });
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'deleteCategory' && (
        <ConfirmDialog
          title={t('guilds.sidebar.deleteCategory.title', { name: dialog.category.name })}
          message={t('guilds.sidebar.deleteCategory.message', { name: dialog.category.name })}
          confirmLabel={t('guilds.sidebar.deleteCategory.confirm')}
          focusConfirm
          onConfirm={() => deleteCategory(guild.id, dialog.category.id)}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'leave' && (
        <ConfirmDialog
          title={t('guilds.sidebar.leave.title', { name: guild.name })}
          message={t('guilds.sidebar.leave.message', { name: guild.name })}
          confirmLabel={t('guilds.sidebar.leaveGuild')}
          onConfirm={async () => {
            await leaveGuild(guild.id);
            guildList.removeGuild(guild.id);
          }}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
