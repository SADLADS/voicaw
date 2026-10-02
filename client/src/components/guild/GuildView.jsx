import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBell, faBellSlash, faThumbtack, faUsers } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/dms.css';
import '../../assets/css/guilds.css';
import { InteractionContext, LayoutContext, NsfwChannelContext } from '../../contexts';
import ChatPane from '../ChatPane';
import MemberList from './MemberList';
import ChannelIcon from './ChannelIcon';
import VoiceChannelView from './VoiceChannelView';
import ListChannelView from './ListChannelView';
import DocChannelView from '../documents/DocChannelView';
import GuildSearch from './GuildSearch';
import ChannelMuteMenu from './ChannelMuteMenu';
import { useChannel } from '../../hooks/useChannel';
import { onGuildEvent } from '../../utils/ws-client';
import { addGuildReaction, fetchChannelMembers, fetchMembers, removeGuildReaction } from '../../services/guildService';
import { defaultChannel, errorMessage, rememberChannel } from '../../utils/guildDisplay';
import { PERMISSIONS, colorToHex, has, memberColor } from '../../utils/permissions';
import { mergeProfiles, nameOf, useProfiles } from '../../utils/profiles';

const SHOW_MEMBERS_KEY = 'showMemberList';

// A guild page (/guild/:guildId/:channelId): the channel's header (name, topic, members
// button), its chat (ChatPane over useChannel) and the member list. Without a channel in the
// URL it opens the one last viewed here (or the first). The guild's channel sidebar is in the
// layout's left column (GuildSidebar).
export default function GuildView({ user }) {
  const { guildId, channelId } = useParams();
  const { isMobile } = useContext(InteractionContext);
  const { guildList } = useContext(LayoutContext);
  const guild = guildList.layouts[guildId];
  const [loadError, setLoadError] = useState(null);
  const [members, setMembers] = useState([]);
  const [showMembers, setShowMembers] = useState(() => {
    try {
      return localStorage.getItem(SHOW_MEMBERS_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  // Mobile: the member list is a panel over the chat, closed until asked for.
  const [membersOpenMobile, setMembersOpenMobile] = useState(false);

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

  useEffect(() => {
    setPinsAnchor(null);
    setMuteAnchor(null);
  }, [channelId]);

  // A search result to scroll to ({ channelId, messageId }), once its channel is loaded.
  const navigate = useNavigate();
  const [jumpTarget, setJumpTarget] = useState(null);
  const clearJump = useCallback(() => setJumpTarget(null), []);
  const jumpToResult = (msg) => {
    setJumpTarget({ channelId: msg.channel_id, messageId: msg.id });
    if (String(msg.channel_id) !== channelId) navigate(`/guild/${guildId}/${msg.channel_id}`);
  };

  const channel = guild?.channels.find((c) => String(c.id) === channelId) ?? null;
  const textChannelId = channel?.type === 'text' ? channelId : null;
  const conversation = useChannel({ channelId: textChannelId, user, onRead: guildList.refreshUnread });

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

  useEffect(() => setMembersOpenMobile(false), [channelId]);

  // Members, kept current: joins, leaves and roles (online status: usePresence).
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
  const channelMembers = useMemo(
    () => (viewers ? members.filter((m) => viewers.has(m.id)) : members),
    [members, viewers]
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
        <p className="guild-placeholder">{loadError === 'Guild not found' ? "This guild doesn't exist, or you're not in it." : loadError}</p>
      </div>
    );
  }
  if (!guild) return <div id="guild-main" className="guild-main" aria-busy="true" />;

  if (!channelId || (missingChannel && checkedMissing === channelId)) {
    const target = defaultChannel(guild);
    if (target) return <Navigate to={`/guild/${guild.id}/${target.id}`} replace />;
    return (
      <div id="guild-main" className="guild-main">
        <p className="guild-placeholder">This guild has no channels yet.</p>
      </div>
    );
  }

  function toggleMembers() {
    if (isMobile) {
      setMembersOpenMobile((open) => !open);
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
  const membersVisible = !isList && (isMobile ? membersOpenMobile : showMembers);
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
    cantSendText: `You do not have permission to reply in #${channel.name}.`,
    canAddReactions: has(permissions, PERMISSIONS.ADD_REACTIONS),
    nameColors,
    onRead: guildList.refreshUnread,
  };

  return (
    <div id="guild-main" className="guild-main">
      <header className="channel-header">
        <ChannelIcon channel={channel} className="channel-header-icon" />
        <h4 className="channel-header-name">{channel?.name ?? ''}</h4>
        {channel?.nsfw && <span className="channel-nsfw-tag" title="Media in this channel is blurred until clicked">NSFW</span>}
        {channel?.topic && (
          <>
            <span className="channel-header-divider" />
            <span className="channel-header-topic" title={channel.topic}>{channel.topic}</span>
          </>
        )}
        {channel && channel.type !== 'voice' && (
          <button
            type="button"
            className={`channel-header-button mute-button${muteAnchor ? ' active' : ''}${muted ? ' muted' : ''}`}
            aria-label={muted ? 'Unmute channel' : 'Mute channel'}
            aria-haspopup="menu"
            aria-expanded={Boolean(muteAnchor)}
            title={muted ? 'Unmute channel' : 'Mute channel'}
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
        {channel?.type === 'text' && (
          <button
            type="button"
            className={`channel-header-button pins-button${pinsAnchor ? ' active' : ''}`}
            aria-label="Pinned messages"
            aria-pressed={Boolean(pinsAnchor)}
            title="Pinned messages"
            onClick={togglePins}
          >
            <FontAwesomeIcon icon={faThumbtack} />
          </button>
        )}
        {!isList && (
        <button
          type="button"
          className={`channel-header-button${membersVisible ? ' active' : ''}`}
          aria-label={membersVisible ? 'Hide member list' : 'Show member list'}
          aria-pressed={membersVisible}
          title={membersVisible ? 'Hide member list' : 'Show member list'}
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

      <div className="guild-body">
        <div className="guild-chat" data-current-user-id={user.id}>
          <NsfwChannelContext.Provider value={Boolean(channel?.nsfw)}>
            {!channel ? (
              <p className="guild-placeholder">Loading…</p>
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
                cantSendText={`You do not have permission to send messages in #${channel.name}.`}
                canAddReactions={has(permissions, PERMISSIONS.ADD_REACTIONS)}
                canPin={has(permissions, PERMISSIONS.PIN_MESSAGES)}
                pinsAnchor={pinsAnchor}
                onClosePins={closePins}
                jumpTo={jumpTarget?.channelId === channel.id && conversation.loadedChannelId === channelId ? jumpTarget : null}
                onJumped={clearJump}
                nameColors={nameColors}
                emptyText={`Welcome to #${channel.name}! This is the start of the channel.`}
              />
            )}
          </NsfwChannelContext.Provider>
        </div>

        {membersVisible && (
          <MemberList
            guild={guild}
            members={channelMembers}
            user={user}
            onClose={isMobile ? () => setMembersOpenMobile(false) : undefined}
          />
        )}
      </div>
    </div>
  );
}
