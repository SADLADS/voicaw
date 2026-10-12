import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBell, faBellSlash, faComments, faMessage, faThumbtack, faUsers } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/dms.css';
import '../../assets/css/guilds.css';
import { GuildMembersContext, InteractionContext, LayoutContext, NsfwChannelContext, ThreadContext } from '../../contexts';
import ChatPane from '../ChatPane';
import MemberList from './MemberList';
import ChannelIcon from './ChannelIcon';
import PaneBackButton from '../PaneBackButton';
import VoiceChannelView from './VoiceChannelView';
import VoiceChatPane from './VoiceChatPane';
import ListChannelView from './ListChannelView';
import DocChannelView from '../documents/DocChannelView';
import GuildSearch from './GuildSearch';
import ChannelMuteMenu from './ChannelMuteMenu';
import ThreadPane from './ThreadPane';
import ThreadList from './ThreadList';
import ThreadDialog from './ThreadDialog';
import { useChannel } from '../../hooks/useChannel';
import { useBackCloses } from '../../hooks/useBackCloses';
import { onGuildEvent } from '../../utils/ws-client';
import { addGuildReaction, fetchChannelMembers, fetchMembers, removeGuildReaction } from '../../services/guildService';
import { defaultChannel, errorMessage, rememberChannel } from '../../utils/guildDisplay';
import { PERMISSIONS, colorToHex, has, memberColor } from '../../utils/permissions';
import { mergeProfiles, nameOf, useProfiles } from '../../utils/profiles';
import { setPersonMenuGuild } from '../../utils/personMenu';
import { useChannelCommands } from '../../hooks/useChannelCommands';
import { handleInteractionResult, runCommand } from '../../services/interactionService';
import { usePreferences, usePreferencesLoaded } from '../../utils/preferences';
import NsfwAgeGate from './NsfwAgeGate';
import { t } from '../../i18n';

const SHOW_MEMBERS_KEY = 'showMemberList';
// Whether a voice channel's chat was last left open (on a computer).
const VOICE_CHAT_KEY = 'voiceChatOpen';

// A guild page (/guild/:guildId/:channelId): the channel's header (name, topic, members
// button), its chat (ChatPane over useChannel) and the member list. In a text channel,
// `?thread=<id>` opens that thread beside it (ThreadPane, in the member list's place; on a
// phone over the chat; on a computer `&full=1` gives it the whole page instead, Discord's full
// view, the channel not loaded meanwhile), and the header's threads button lists the channel's threads. Without a channel in the
// URL it opens the one last viewed here (or the first). In a voice channel, `?chat=1` opens its
// chat beside it (VoiceChatPane, in the member list's place; on a phone over the voice page);
// on a computer it reopens open if it was left open. The guild's channel sidebar is in the
// layout's left column (GuildSidebar).
export default function GuildView({ user }) {
  const { guildId, channelId } = useParams();
  const { isMobile } = useContext(InteractionContext);
  const { guildList } = useContext(LayoutContext);
  const guild = guildList.layouts[guildId];
  const [loadError, setLoadError] = useState(null);
  const [members, setMembers] = useState([]);
  // A person's menu (utils/personMenu.js) offers Make Owner, Kick and Ban for this guild's members.
  useEffect(() => {
    setPersonMenuGuild(guild ? { guild, members } : null);
  }, [guild, members]);
  useEffect(() => () => setPersonMenuGuild(null), []);
  const [showMembers, setShowMembers] = useState(() => {
    try {
      return localStorage.getItem(SHOW_MEMBERS_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  // Phones: the member list covers the whole page, closed until asked for; Back (or a swipe
  // to the right, in MemberList) closes it.
  const [membersOpenMobile, openMembersMobile, closeMembersMobile] = useBackCloses('voicawMemberList');

  // The pinned messages list, under its header button (null: closed).
  const [pinsAnchor, setPinsAnchor] = useState(null);
  const closePins = useCallback(() => setPinsAnchor(null), []);
  const togglePins = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPinsAnchor((open) => (open ? null : rect));
  };

  // The mute menu, under the header's bell (null: closed).
  const [muteAnchor, setMuteAnchor] = useState(null);
  const closeMute = useCallback(() => setMuteAnchor(null), []);

  // The thread open beside the channel, its list (under its header button) and the dialog
  // starting one ({ message } or {} for one on its own).
  const [searchParams, setSearchParams] = useSearchParams();
  const threadId = searchParams.get('thread');
  const [threadsAnchor, setThreadsAnchor] = useState(null);
  const closeThreads = useCallback(() => setThreadsAnchor(null), []);
  const [startingThread, setStartingThread] = useState(null);

  useEffect(() => {
    setPinsAnchor(null);
    setMuteAnchor(null);
    setThreadsAnchor(null);
    setStartingThread(null);
  }, [channelId]);

  // A search result to scroll to ({ channelId, messageId }), once its channel is loaded.
  const navigate = useNavigate();
  const [jumpTarget, setJumpTarget] = useState(null);
  const clearJump = useCallback(() => setJumpTarget(null), []);
  const jumpToResult = (msg) => {
    setJumpTarget({ channelId: msg.channel_id, messageId: msg.id });
    // A voice channel's messages are in its chat.
    const voiceChannel = guild?.channels.find((c) => c.id === msg.channel_id)?.type === 'voice';
    if (String(msg.channel_id) !== channelId || (voiceChannel && !voiceChatOpen)) {
      navigate(`/guild/${guildId}/${msg.channel_id}${voiceChannel ? '?chat=1' : ''}`);
    }
  };

  const channel = guild?.channels.find((c) => String(c.id) === channelId) ?? null;
  // An NSFW channel stays closed (NsfwAgeGate: nothing loaded, nothing marked read) until you've
  // said you're 18 or over; until your preferences have loaded, it's only "Loading…".
  const { adultConfirmed } = usePreferences();
  const preferencesReady = usePreferencesLoaded();
  const ageGated = Boolean(channel?.nsfw) && !(preferencesReady && adultConfirmed);
  const textChannelId = channel?.type === 'text' && !ageGated ? channelId : null;
  const openThreadId = textChannelId && threadId ? threadId : null;
  const threadFull = Boolean(openThreadId) && !isMobile && searchParams.get('full') === '1';
  // A voice channel's chat: loaded (and marked read) only while it's open.
  const isVoice = channel?.type === 'voice';
  const voiceChatOpen = isVoice && searchParams.get('chat') === '1';
  const chatChannelId = threadFull ? null : textChannelId ?? (voiceChatOpen && !ageGated ? channelId : null);
  // On a phone it's a page of its own: Back closes it.
  const setVoiceChat = useCallback((open) => {
    setSearchParams(open ? { chat: '1' } : {}, { replace: !isMobile || !open });
  }, [isMobile, setSearchParams]);
  // On a computer, a voice channel opens with its chat if it was left open (however it was
  // opened or closed: the header, the channel list's button, a search result).
  const chatParam = searchParams.get('chat');
  const arrivedAt = useRef(null);
  useEffect(() => {
    if (!isVoice || isMobile) {
      arrivedAt.current = null;
      return;
    }
    const arrived = arrivedAt.current !== channelId;
    arrivedAt.current = channelId;
    try {
      if (arrived && !chatParam) {
        if (localStorage.getItem(VOICE_CHAT_KEY) === 'true') setSearchParams({ chat: '1' }, { replace: true });
      } else {
        localStorage.setItem(VOICE_CHAT_KEY, String(chatParam === '1'));
      }
    } catch {
      // Storage unavailable: not remembered.
    }
  }, [channelId, isVoice, isMobile, chatParam, setSearchParams]);

  const openThread = useCallback((id) => {
    setThreadsAnchor(null);
    setSearchParams({ thread: String(id) }, { replace: isMobile ? false : Boolean(threadId) });
  }, [setSearchParams, isMobile, threadId]);
  const closeThread = useCallback(() => setSearchParams({}, { replace: true }), [setSearchParams]);
  const setThreadFull = useCallback((full) => {
    setSearchParams(full ? { thread: threadId, full: '1' } : { thread: threadId }, { replace: true });
  }, [setSearchParams, threadId]);
  const canCreateThreads = has(channel?.my_permissions, PERMISSIONS.CREATE_THREADS);
  const threadContext = useMemo(() => ({
    openThread,
    createThread: canCreateThreads ? (msg) => setStartingThread({ message: msg }) : null,
    // A thread on its own (the message box's + menu).
    startThread: canCreateThreads ? () => setStartingThread({}) : null,
    // From a "started a thread" row: the list opens under the header's button.
    showThreads: () => setThreadsAnchor(document.querySelector('.threads-button')?.getBoundingClientRect() ?? null),
  }), [openThread, canCreateThreads]);
  const conversation = useChannel({ channelId: chatChannelId, user, onRead: guildList.refreshUnread });

  // Load the guild's layout if this is the first visit (or it just appeared).
  const { loadGuild } = guildList;
  useEffect(() => {
    setLoadError(null);
    if (guild) return;
    loadGuild(guildId).catch((err) => setLoadError(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, loadGuild]);

  // A channel that isn't in the layout may have just been created: fetch the layout again. If
  // it's still not there (deleted), go to another channel.
  const missingChannel = Boolean(guild && channelId && !channel);
  const [checkedMissing, setCheckedMissing] = useState(null);
  useEffect(() => {
    if (!missingChannel) return;
    loadGuild(guildId).catch(() => {}).finally(() => setCheckedMissing(channelId));
  }, [missingChannel, guildId, channelId, loadGuild]);

  // The guild reopens on the last text, list or document channel (a voice one would just show
  // who's talking).
  useEffect(() => {
    if (['text', 'list', 'doc'].includes(channel?.type)) rememberChannel(guildId, channel.id);
  }, [guildId, channel]);

  useEffect(() => closeMembersMobile(), [channelId, closeMembersMobile]);

  // Members, kept current: joins, leaves, roles and XP (online status: usePresence).
  useEffect(() => {
    let cancelled = false;
    setMembers([]);
    fetchMembers(guildId)
      .then((list) => {
        mergeProfiles(list);
        if (!cancelled) setMembers(list);
      })
      .catch((err) => console.warn('Failed to load members', err));
    const id = Number(guildId);
    const offGuild = onGuildEvent((event) => {
      if (event.guildId !== id) return;
      if (event.type === 'guild_member_add') {
        setMembers((prev) => (prev.some((m) => m.id === event.member.id) ? prev : [...prev, event.member]
          .sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' }))));
      } else if (event.type === 'guild_member_remove') {
        setMembers((prev) => prev.filter((m) => m.id !== event.userId));
      } else if (event.type === 'guild_member_update') {
        setMembers((prev) => prev.map((m) => (m.id === event.userId ? { ...m, role_ids: event.roleIds } : m)));
      } else if (event.type === 'guild_member_xp') {
        setMembers((prev) => prev.map((m) => (m.id === event.userId ? { ...m, xp: event.xp } : m)));
      }
    });
    return () => {
      cancelled = true;
      offGuild();
    };
  }, [guildId]);

  // Who can see the channel (a Set of user ids; null until known): the member list and "@"
  // suggestions only show them. Fetched again when anything that could change it happens.
  const [viewers, setViewers] = useState(null);
  const viewedChannelId = channel?.id ?? null;
  useEffect(() => {
    setViewers(null);
    if (!viewedChannelId) return undefined;
    let cancelled = false;
    const load = () => fetchChannelMembers(viewedChannelId)
      .then((ids) => { if (!cancelled) setViewers(new Set(ids)); })
      .catch((err) => console.warn('Failed to load who can see the channel', err));
    load();
    const id = Number(guildId);
    const off = onGuildEvent((event) => {
      if (event.guildId !== id && event.guild?.id !== id) return;
      if (['guild_update', 'guild_member_add', 'guild_member_remove', 'guild_member_update'].includes(event.type)) load();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [guildId, viewedChannelId]);
  // The channel's bots' user commands, for the member card's Apps (channels with a chat).
  const { commands: channelCommands } = useChannelCommands(viewedChannelId, { enabled: channel?.type === 'text' || channel?.type === 'voice' });
  const userApps = useMemo(() => channelCommands.filter((c) => c.type === 2), [channelCommands]);
  const runUserApp = useCallback(async (command, userId) => {
    handleInteractionResult(await runCommand(viewedChannelId, { commandId: command.id, targetId: userId }));
  }, [viewedChannelId]);
  const channelMembers = useMemo(
    () => (viewers ? members.filter((m) => viewers.has(m.id)) : members),
    [members, viewers]
  );
  // A name or picture in the guild's chats opens the same member card as the list.
  const membersContext = useMemo(
    () => (guild ? { guild, members, user, userApps, onRunUserApp: runUserApp } : null),
    [guild, members, user, userApps, runUserApp]
  );

  const profilesVersion = useProfiles();
  const reactionNames = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, nameOf(m)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members, profilesVersion]
  );
  // Each member's name colour: their highest coloured role's (none: the normal colour).
  const roles = guild?.roles;
  // Roles for mentions: every one to draw them, those you may mention to suggest.
  const mentionRoles = useMemo(
    () => Object.fromEntries((roles ?? []).filter((r) => !r.is_everyone)
      .map((r) => [r.id, { name: r.name, color: r.color != null ? colorToHex(r.color) : null }])),
    [roles]
  );
  const canMentionEveryone = has(guild?.my_permissions, PERMISSIONS.MENTION_EVERYONE);
  const suggestRoles = useMemo(
    () => (roles ?? []).filter((r) => !r.is_everyone && (r.mentionable || canMentionEveryone))
      .map((r) => ({ id: r.id, name: r.name, color: r.color != null ? colorToHex(r.color) : null })),
    [roles, canMentionEveryone]
  );
  // Channels "#name" suggests: those you can see, in the channel list's order, with their category.
  const layoutChannels = guild?.channels;
  const layoutCategories = guild?.categories;
  const mentionChannels = useMemo(() => {
    const all = layoutChannels ?? [];
    const withCategory = (c, category) => ({ id: c.id, name: c.name, type: c.type, private: c.private, category: category?.name ?? null });
    return [
      ...all.filter((c) => c.category_id == null).map((c) => withCategory(c, null)),
      ...(layoutCategories ?? []).flatMap((cat) => all.filter((c) => c.category_id === cat.id).map((c) => withCategory(c, cat))),
    ];
  }, [layoutChannels, layoutCategories]);
  const nameColors = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, memberColor(roles, m.role_ids)]).filter(([, c]) => c)),
    [members, roles]
  );

  if (loadError) {
    return (
      <div id="guild-main" className="guild-main">
        <p className="guild-placeholder">{loadError === 'Guild not found' ? t('guilds.view.notFound') : loadError}</p>
      </div>
    );
  }
  if (!guild) return <div id="guild-main" className="guild-main" aria-busy="true" />;

  if (!channelId || (missingChannel && checkedMissing === channelId)) {
    const target = defaultChannel(guild);
    // An event link (?event=) keeps its event for the sidebar to open.
    const event = searchParams.get('event');
    if (target) return <Navigate to={`/guild/${guild.id}/${target.id}${event ? `?event=${event}` : ''}`} replace />;
    return (
      <div id="guild-main" className="guild-main">
        <p className="guild-placeholder">{t('guilds.view.noChannels')}</p>
      </div>
    );
  }

  function toggleMembers() {
    if (isMobile) {
      if (membersOpenMobile) closeMembersMobile();
      else openMembersMobile();
      return;
    }
    setShowMembers((show) => {
      try {
        localStorage.setItem(SHOW_MEMBERS_KEY, String(!show));
      } catch {
        // Not remembered, then.
      }
      return !show;
    });
  }

  // A list channel uses the space for its tasks' details instead, a document channel for replies.
  const isList = channel?.type === 'list' || channel?.type === 'doc';
  // An open thread, or a voice channel's chat, takes the member list's place.
  const membersVisible = !isList && !openThreadId && !voiceChatOpen && (isMobile ? membersOpenMobile : showMembers);
  const permissions = channel?.my_permissions ?? 0;
  const muted = Boolean(channel && guildList.isMuted(channel.id));
  // What a channel's chat (ChatPane) takes from the guild, for a document channel's replies.
  const chatProps = channel && {
    pollKind: 'guild',
    encrypted: false,
    user,
    reactionsReady: true,
    saveReaction: (msg, emoji) => addGuildReaction(msg.id, emoji),
    deleteReaction: removeGuildReaction,
    reactionNames,
    people: channelMembers,
    mentionRoles,
    myRoleIds: guild.my_role_ids,
    suggestRoles,
    canMentionEveryone,
    channels: mentionChannels,
    canModerate: has(permissions, PERMISSIONS.MANAGE_MESSAGES),
    canSend: has(permissions, PERMISSIONS.SEND_MESSAGES),
    cantSendText: t('guilds.view.cantReply', { name: channel.name }),
    canAddReactions: has(permissions, PERMISSIONS.ADD_REACTIONS),
    nameColors,
    onRead: guildList.refreshUnread,
  };

  // Beside the chat on a computer; on a phone over the whole page, header included.
  const memberList = membersVisible && (
    <MemberList
      guild={guild}
      members={channelMembers}
      user={user}
      userApps={userApps}
      onRunUserApp={runUserApp}
      onClose={isMobile ? closeMembersMobile : undefined}
    />
  );

  return (
    <GuildMembersContext.Provider value={membersContext}>
      <div id="guild-main" className="guild-main">
        {/* A thread in full view has its own header. */}
        {!threadFull && (
        <header className="channel-header">
          <PaneBackButton />
          <ChannelIcon channel={channel} className="channel-header-icon" />
          <h4 className="channel-header-name">{channel?.name ?? ''}</h4>
          {channel?.nsfw && <span className="channel-nsfw-tag" title={t('guilds.view.nsfwHint')}>{t('guilds.view.nsfw')}</span>}
          {channel?.topic && (
            <>
              <span className="channel-header-divider" />
              <span className="channel-header-topic" title={channel.topic}>{channel.topic}</span>
            </>
          )}
          {isVoice && (
            <button
              type="button"
              className={`channel-header-button voice-chat-button${voiceChatOpen ? ' active' : ''}`}
              aria-label={voiceChatOpen ? t('guilds.voiceChat.hide') : t('guilds.voiceChat.show')}
              aria-pressed={voiceChatOpen}
              title={voiceChatOpen ? t('guilds.voiceChat.hide') : t('guilds.voiceChat.show')}
              onClick={() => setVoiceChat(!voiceChatOpen)}
            >
              <FontAwesomeIcon icon={faMessage} />
            </button>
          )}
          {channel && (
            <button
              type="button"
              className={`channel-header-button mute-button${muteAnchor ? ' active' : ''}${muted ? ' muted' : ''}`}
              aria-label={muted ? t('guilds.view.unmuteChannel') : t('guilds.view.muteChannel')}
              aria-haspopup="menu"
              aria-expanded={Boolean(muteAnchor)}
              title={muted ? t('guilds.view.unmuteChannel') : t('guilds.view.muteChannel')}
              // The menu closes itself on a press outside it; this press is its toggle.
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMuteAnchor((open) => (open ? null : rect));
              }}
            >
              <FontAwesomeIcon icon={muted ? faBellSlash : faBell} />
            </button>
          )}
          {muteAnchor && channel && <ChannelMuteMenu channel={channel} anchor={muteAnchor} align="end" onClose={closeMute} />}
          {chatChannelId && (
            <button
              type="button"
              className={`channel-header-button pins-button${pinsAnchor ? ' active' : ''}`}
              aria-label={t('guilds.view.pinnedMessages')}
              aria-pressed={Boolean(pinsAnchor)}
              title={t('guilds.view.pinnedMessages')}
              onClick={togglePins}
            >
              <FontAwesomeIcon icon={faThumbtack} />
            </button>
          )}
          {textChannelId && (
            <button
              type="button"
              className={`channel-header-button threads-button${threadsAnchor ? ' active' : ''}`}
              aria-label={t('guilds.view.threads')}
              aria-pressed={Boolean(threadsAnchor)}
              title={t('guilds.view.threads')}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setThreadsAnchor((open) => (open ? null : rect));
              }}
            >
              <FontAwesomeIcon icon={faComments} />
            </button>
          )}
          {!isList && (
          <button
            type="button"
            className={`channel-header-button${membersVisible ? ' active' : ''}`}
            aria-label={membersVisible ? t('guilds.view.hideMembers') : t('guilds.view.showMembers')}
            aria-pressed={membersVisible}
            title={membersVisible ? t('guilds.view.hideMembers') : t('guilds.view.showMembers')}
            onClick={toggleMembers}
          >
            <FontAwesomeIcon icon={faUsers} />
          </button>
          )}
          <GuildSearch
            guild={guild}
            members={members}
            user={user}
            isMobile={isMobile}
            onJump={jumpToResult}
            reactionNames={reactionNames}
            mentionRoles={mentionRoles}
            nameColors={nameColors}
          />
        </header>
        )}

        <div className="guild-body">
          {!threadFull && (
          <ThreadContext.Provider value={channel?.type === 'text' ? threadContext : null}>
          <div className="guild-chat" data-current-user-id={user.id}>
            <NsfwChannelContext.Provider value={Boolean(channel?.nsfw)}>
              {!channel || (ageGated && !preferencesReady) ? (
                <p className="guild-placeholder">{t('common.loading')}</p>
              ) : ageGated ? (
                <NsfwAgeGate channelName={channel.name} onBack={() => navigate(-1)} />
              ) : channel.type === 'voice' ? (
                <VoiceChannelView guild={guild} channel={channel} nameColors={nameColors} />
              ) : channel.type === 'list' ? (
                <ListChannelView
                  guild={guild}
                  channel={channel}
                  user={user}
                  people={channelMembers}
                  reactionNames={reactionNames}
                  mentionRoles={mentionRoles}
                  nameColors={nameColors}
                  isMobile={isMobile}
                />
              ) : channel.type === 'doc' ? (
                <DocChannelView
                  guild={guild}
                  channel={channel}
                  user={user}
                  isMobile={isMobile}
                  nameColors={nameColors}
                  chatProps={chatProps}
                />
              ) : (
                <ChatPane
                  pollKind="guild"
                  chatId={`channel-${channel.id}`}
                  encrypted={false}
                  chatName={`#${channel.name}`}
                  user={user}
                  conversation={conversation}
                  reactionsReady
                  saveReaction={(msg, emoji) => addGuildReaction(msg.id, emoji)}
                  deleteReaction={removeGuildReaction}
                  reactionNames={reactionNames}
                  people={channelMembers}
                  mentionRoles={mentionRoles}
                  myRoleIds={guild.my_role_ids}
                  suggestRoles={suggestRoles}
                  canMentionEveryone={canMentionEveryone}
                  channels={mentionChannels}
                  canModerate={has(permissions, PERMISSIONS.MANAGE_MESSAGES)}
                  canSend={has(permissions, PERMISSIONS.SEND_MESSAGES)}
                  cantSendText={t('guilds.view.cantSend', { name: channel.name })}
                  canAddReactions={has(permissions, PERMISSIONS.ADD_REACTIONS)}
                  canPin={has(permissions, PERMISSIONS.PIN_MESSAGES)}
                  pinsAnchor={pinsAnchor}
                  onClosePins={closePins}
                  jumpTo={jumpTarget?.channelId === channel.id && conversation.loadedChannelId === channelId ? jumpTarget : null}
                  onJumped={clearJump}
                  nameColors={nameColors}
                  emptyText={t('guilds.view.welcome', { name: channel.name })}
                  // A thread opened beside it takes the focus instead.
                  focusOnOpen={!openThreadId}
                />
              )}
            </NsfwChannelContext.Provider>
          </div>
          </ThreadContext.Provider>
          )}

          {openThreadId && (
            <NsfwChannelContext.Provider value={Boolean(channel.nsfw)}>
              <ThreadPane
                key={openThreadId}
                guild={guild}
                parent={channel}
                threadId={openThreadId}
                user={user}
                isMobile={isMobile}
                chatProps={chatProps}
                full={threadFull}
                onSetFull={setThreadFull}
                onClose={closeThread}
              />
            </NsfwChannelContext.Provider>
          )}

          {voiceChatOpen && !ageGated && (
            <VoiceChatPane
              channel={channel}
              conversation={conversation}
              isMobile={isMobile}
              chatProps={chatProps}
              pins={{ anchor: pinsAnchor, onClose: closePins }}
              jump={{
                jumpTo: jumpTarget?.channelId === channel.id && conversation.loadedChannelId === channelId ? jumpTarget : null,
                onJumped: clearJump,
              }}
              onClose={() => setVoiceChat(false)}
            />
          )}

          {!isMobile && memberList}
        </div>
        {isMobile && memberList}

        {threadsAnchor && textChannelId && (
          <ThreadList
            channel={channel}
            anchor={threadsAnchor}
            isMobile={isMobile}
            canCreate={canCreateThreads}
            onOpen={(thread) => openThread(thread.id)}
            onCreate={() => { setThreadsAnchor(null); setStartingThread({}); }}
            onClose={closeThreads}
          />
        )}
        {startingThread && channel && (
          <ThreadDialog
            channel={channel}
            message={startingThread.message ?? null}
            onDone={(thread) => openThread(thread.id)}
            onClose={() => setStartingThread(null)}
          />
        )}
      </div>
    </GuildMembersContext.Provider>
  );
}
