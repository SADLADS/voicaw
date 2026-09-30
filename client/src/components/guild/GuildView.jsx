import React, { useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faUsers } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/dms.css';
import '../../assets/css/guilds.css';
import { InteractionContext, LayoutContext } from '../../contexts';
import ChatPane from '../ChatPane';
import MemberList from './MemberList';
import ChannelIcon from './ChannelIcon';
import VoiceChannelView from './VoiceChannelView';
import { useChannel } from '../../hooks/useChannel';
import { onGuildEvent } from '../../utils/ws-client';
import { addGuildReaction, fetchChannelMembers, fetchMembers, removeGuildReaction } from '../../services/guildService';
import { defaultChannel, errorMessage, rememberChannel } from '../../utils/guildDisplay';
import { PERMISSIONS, colorToHex, has, memberColor } from '../../utils/permissions';

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

  // The guild reopens on the last text channel (a voice one would just show who's talking).
  useEffect(() => {
    if (channel?.type === 'text') rememberChannel(guildId, channel.id);
  }, [guildId, channel]);

  useEffect(() => setMembersOpenMobile(false), [channelId]);

  // Members, kept current: joins, leaves and roles (online status: usePresence).
  useEffect(() => {
    let cancelled = false;
    setMembers([]);
    fetchMembers(guildId)
      .then((list) => { if (!cancelled) setMembers(list); })
      .catch((err) => console.warn('Failed to load members', err));
    const id = Number(guildId);
    const offGuild = onGuildEvent((event) => {
      if (event.guildId !== id) return;
      if (event.type === 'guild_member_add') {
        setMembers((prev) => (prev.some((m) => m.id === event.member.id) ? prev : [...prev, event.member]
          .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }))));
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

  const reactionNames = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, m.username])),
    [members]
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
  const nameColors = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, memberColor(roles, m.role_ids)]).filter(([, c]) => c)),
    [members, roles]
  );

  if (loadError) {
    return (
      <div id="guild-main" className="guild-main">
        <p className="guild-placeholder">{loadError === 'Guild not found' ? "This server doesn't exist, or you're not in it." : loadError}</p>
      </div>
    );
  }
  if (!guild) return <div id="guild-main" className="guild-main" aria-busy="true" />;

  if (!channelId || (missingChannel && checkedMissing === channelId)) {
    const target = defaultChannel(guild);
    if (target) return <Navigate to={`/guild/${guild.id}/${target.id}`} replace />;
    return (
      <div id="guild-main" className="guild-main">
        <p className="guild-placeholder">This server has no channels yet.</p>
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

  const membersVisible = isMobile ? membersOpenMobile : showMembers;
  const permissions = channel?.my_permissions ?? 0;

  return (
    <div id="guild-main" className="guild-main">
      <header className="channel-header">
        <ChannelIcon channel={channel} className="channel-header-icon" />
        <h4 className="channel-header-name">{channel?.name ?? ''}</h4>
        {channel?.topic && (
          <>
            <span className="channel-header-divider" />
            <span className="channel-header-topic" title={channel.topic}>{channel.topic}</span>
          </>
        )}
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
      </header>

      <div className="guild-body">
        <div className="guild-chat" data-current-user-id={user.id}>
          {!channel ? (
            <p className="guild-placeholder">Loading…</p>
          ) : channel.type === 'voice' ? (
            <VoiceChannelView guild={guild} channel={channel} nameColors={nameColors} />
          ) : (
            <ChatPane
              chatId={`channel-${channel.id}`}
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
              canModerate={has(permissions, PERMISSIONS.MANAGE_MESSAGES)}
              canSend={has(permissions, PERMISSIONS.SEND_MESSAGES)}
              cantSendText={`You do not have permission to send messages in #${channel.name}.`}
              canAddReactions={has(permissions, PERMISSIONS.ADD_REACTIONS)}
              nameColors={nameColors}
              emptyText={`Welcome to #${channel.name}! This is the start of the channel.`}
            />
          )}
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
