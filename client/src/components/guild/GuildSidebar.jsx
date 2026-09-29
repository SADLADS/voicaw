import React, { useContext, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown,
  faChevronRight,
  faFolderPlus,
  faGear,
  faPlus,
  faRightFromBracket,
  faUserPlus,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { ConfigContext, InteractionContext, LayoutContext } from '../../contexts';
import { scrollToRight } from '../../utils/scrollToRight';
import { groupChannels } from '../../utils/guildDisplay';
import { leaveGuild } from '../../services/guildService';
import InviteDialog from './InviteDialog';
import ChannelDialog from './ChannelDialog';
import CategoryDialog from './CategoryDialog';
import GuildSettingsDialog from './GuildSettingsDialog';
import ConfirmDialog from './ConfirmDialog';
import ChannelIcon from './ChannelIcon';
import VoiceChannelMembers from './VoiceChannelMembers';
import { useVoice } from '../../hooks/useVoice';
import { joinVoice } from '../../voice/voiceClient';
import { PERMISSIONS, has } from '../../utils/permissions';

const COLLAPSED_KEY = 'collapsedCategories';

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

// The guild's column next to the server rail (like Discord): its name, with a menu (invite,
// settings, create channel/category, leave), then its channels, grouped in collapsible
// categories. Unread channels are bold; private ones have a lock. What's offered follows the
// member's permissions (Manage Channels: edit buttons, creating; Create Invite; Manage Server,
// Manage Roles or Ban Members: Server Settings).
export default function GuildSidebar({ guild, user }) {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const { guildList } = useContext(LayoutContext);
  const { isMobile } = useContext(InteractionContext);
  const { voiceEnabled } = useContext(ConfigContext);
  const voice = useVoice();
  const [menuOpen, setMenuOpen] = useState(false);
  // { type: 'invite' | 'settings' | 'channel' | 'category' | 'leave', ...props }
  const [dialog, setDialog] = useState(null);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const menuRef = useRef(null);

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
  const unreadChannels = new Set(guildList.unread.filter((u) => u.guild_id === guild.id).map((u) => u.channel_id));
  const { uncategorized, categories } = groupChannels(guild);
  const inVoice = voice.status !== 'idle' && voice.guildId === guild.id ? voice.channelId : null;
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

  // A voice channel joins on click (desktop). On mobile a tap only opens it, and it's joined
  // from there: a stray tap shouldn't put you on a call.
  function openChannel(channel) {
    if (channel.type === 'voice' && !isMobile && voiceEnabled && has(channel.my_permissions, PERMISSIONS.CONNECT)) {
      joinVoice(guild.id, channel.id);
    }
    scrollToRight();
  }

  function renderChannel(channel) {
    const active = String(channel.id) === channelId;
    const unread = unreadChannels.has(channel.id) && !active;
    const connected = channel.id === inVoice;
    return (
      <React.Fragment key={channel.id}>
      <li className={`guild-channel${active ? ' active' : ''}${unread ? ' unread' : ''}${connected ? ' connected' : ''}`}>
        <Link
          to={`/guild/${guild.id}/${channel.id}`}
          onClick={() => openChannel(channel)}
          className="guild-channel-link"
          aria-current={active ? 'page' : undefined}
        >
          <ChannelIcon channel={channel} className="guild-channel-icon" />
          <span className="guild-channel-name">{channel.name}</span>
        </Link>
        {managesChannels && (
          <button
            type="button"
            className="guild-sidebar-icon-button"
            aria-label={`Edit ${channel.name}`}
            title="Edit channel"
            onClick={() => openDialog({ type: 'channel', channel })}
          >
            <FontAwesomeIcon icon={faGear} />
          </button>
        )}
      </li>
      {channel.voice?.length > 0 && (
        <li className="guild-channel-voice">
          <VoiceChannelMembers members={channel.voice} speaking={channel.id === inVoice ? speaking : new Set()} />
        </li>
      )}
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
                Invite People <FontAwesomeIcon icon={faUserPlus} />
              </button>
            )}
            {opensSettings && (
              <button type="button" role="menuitem" className="guild-menu-item" onClick={() => openDialog({ type: 'settings' })}>
                Server Settings <FontAwesomeIcon icon={faGear} />
              </button>
            )}
            {managesChannels && (
              <>
                <button type="button" role="menuitem" className="guild-menu-item" onClick={() => openDialog({ type: 'channel' })}>
                  Create Channel <FontAwesomeIcon icon={faPlus} />
                </button>
                <button type="button" role="menuitem" className="guild-menu-item" onClick={() => openDialog({ type: 'category' })}>
                  Create Category <FontAwesomeIcon icon={faFolderPlus} />
                </button>
              </>
            )}
            {!isOwner && (
              <>
                <div className="guild-menu-separator" />
                <button type="button" role="menuitem" className="guild-menu-item danger" onClick={() => openDialog({ type: 'leave' })}>
                  Leave Server <FontAwesomeIcon icon={faRightFromBracket} />
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <nav className="guild-channel-list" aria-label="Channels">
        <ul>{uncategorized.map(renderChannel)}</ul>

        {categories.map((category) => {
          const isCollapsed = collapsed.has(category.id);
          // Collapsed, a category still shows the open channel, unread ones and your voice
          // channel (like Discord).
          const shown = isCollapsed
            ? category.channels.filter((c) => String(c.id) === channelId || unreadChannels.has(c.id) || c.id === inVoice)
            : category.channels;
          return (
            <div key={category.id} className="guild-category">
              <div className="guild-category-header">
                <button
                  type="button"
                  className="guild-category-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleCategory(category.id)}
                >
                  <FontAwesomeIcon icon={isCollapsed ? faChevronRight : faChevronDown} className="guild-category-chevron" />
                  <span>{category.name}</span>
                </button>
                {managesChannels && (
                  <>
                    <button
                      type="button"
                      className="guild-sidebar-icon-button"
                      aria-label={`Edit category ${category.name}`}
                      title="Edit category"
                      onClick={() => openDialog({ type: 'category', category })}
                    >
                      <FontAwesomeIcon icon={faGear} />
                    </button>
                    <button
                      type="button"
                      className="guild-sidebar-icon-button"
                      aria-label={`Create channel in ${category.name}`}
                      title="Create channel"
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
          <p className="guild-sidebar-empty">No channels yet.</p>
        )}
      </nav>

      {dialog?.type === 'invite' && <InviteDialog guild={guild} onClose={closeDialog} />}
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
      {dialog?.type === 'leave' && (
        <ConfirmDialog
          title={`Leave '${guild.name}'`}
          message={`Are you sure you want to leave ${guild.name}? You won't be able to rejoin unless you are re-invited.`}
          confirmLabel="Leave Server"
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
