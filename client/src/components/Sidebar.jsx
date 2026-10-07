import React, { useCallback, useContext, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComments, faPlus, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import logo from '../assets/images/logo-no-border.svg';
import GuildIcon from './guild/GuildIcon';
import Avatar from './Avatar';
import '../assets/css/guilds.css';
import AddGuildDialog from './guild/AddGuildDialog';
import GuildMenu from './guild/GuildMenu';
import InviteDialog from './guild/InviteDialog';
import GuildSettingsDialog from './guild/GuildSettingsDialog';
import AuditLogDialog from './guild/AuditLogDialog';
import LeaderboardDialog from './guild/LeaderboardDialog';
import ConfirmDialog from './guild/ConfirmDialog';
import { InteractionContext, LayoutContext } from '../contexts';
import { leaveGuild } from '../services/guildService';
import { useDragReorder } from '../hooks/useDragReorder';
import { useVoice } from '../hooks/useVoice';
import { t } from '../i18n';
import { displayName } from '../utils/profiles';

// The guild rail down the left (like Discord's): home, DMs, then each guild (a pill on the
// left marks unread messages, a taller one the open guild), then "+" to create or join one.
// `unreadGuildIds` is a Set of guild ids with unread messages, `guildMentions` ({ guildId:
// count }) how many of them mention you (a red badge on the icon). `guildVoice` ({ guildId:
// 'self' | 'others' }) puts a speaker on guilds with someone in a voice channel you can see:
// grey, or green when you're in one there (this device counts as soon as it connects). Guilds can be dragged into a
// new order (hold, then drag, on touch screens); `onReorderGuilds(ids)` saves it. Right-clicking
// a guild (touch, hold and lift on a phone) opens its menu (GuildMenu), whose dialogs live here.
// `unreadFrom` is whoever sent the newest unread DM or group message: the DM button shows their
// picture instead of its icon until that's read (as in Discord).
export default function Sidebar({ user, hasUnreadDms, unreadFrom = null,guilds = [], unreadGuildIds = new Set(), guildMentions = {}, guildVoice = {}, onReorderGuilds }) {
  const location = useLocation();
  const { guildList } = useContext(LayoutContext) ?? {};
  const { isMobile } = useContext(InteractionContext);
  const myVoice = useVoice();
  const myVoiceGuildId = myVoice.status === 'idle' ? null : myVoice.guildId;
  const [adding, setAdding] = useState(false);
  // { guildId, anchor } while a guild's menu is open; { type, guildId } for one of its dialogs.
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeDialog = () => setDialog(null);
  const { drag, itemProps } = useDragReorder(guilds.map((g) => g.id), (ids) => onReorderGuilds?.(ids), {
    onMenu: guildList ? (guildId, anchor) => setMenu({ guildId, anchor }) : undefined,
  });
  const dialogGuild = dialog ? guildList?.layouts[dialog.guildId] : null;
  // While dragging, the others make room where it will land.
  const dragFrom = drag ? guilds.findIndex((g) => g.id === drag.id) : -1;

  // Helper to check if path is active (starts with)
  const isActivePath = (path) => location.pathname.startsWith(path);

  return (
    <div
      className="sidebar d-flex flex-column align-items-center"
      style={{ width: '72px' }}
    >
      <div className="nav-item">
      <NavLink to="/" className="" style={{ display: 'block' }}>
      <img src={logo} alt={t('app.sidebar.logoAlt')} style={{ width: '50px', height: '50px' }} />

      </NavLink>
      </div>

      <div className={`nav-item ${isActivePath('/dm') ? 'active' : ''}`}>
      <span className={`dot${hasUnreadDms ? ' visible' : ''}`}></span>
        {unreadFrom != null ? (
          <NavLink
            to="/dm"
            className="nav-icon rail-dm-unread"
            aria-label={t('app.sidebar.unreadFrom', { name: displayName(unreadFrom) })}
            title={t('app.sidebar.unreadFrom', { name: displayName(unreadFrom) })}
          >
            <Avatar userId={unreadFrom} />
          </NavLink>
        ) : (
          <NavLink to="/dm" className="nav-icon" aria-label={t('app.sidebar.directMessages')} title={t('app.sidebar.directMessages')}>
            <FontAwesomeIcon icon={faComments} />
          </NavLink>
        )}
      </div>

      {guilds.length > 0 && <div className="rail-separator" />}

      <nav className={`rail-guilds${drag ? ' reordering' : ''}`} aria-label={t('app.sidebar.guilds')}>
        {guilds.map((guild, index) => {
          const dragging = drag?.id === guild.id;
          // Items between where it was and where it's going shift by one slot.
          let shift = 0;
          if (drag && !dragging) {
            if (index > dragFrom && index <= drag.targetIndex) shift = -1;
            else if (index < dragFrom && index >= drag.targetIndex) shift = 1;
          }
          const inVoice = myVoiceGuildId != null && String(myVoiceGuildId) === String(guild.id) ? 'self' : guildVoice[guild.id];
          return (
            <div
              key={guild.id}
              className={`nav-item${isActivePath(`/guild/${guild.id}/`) || location.pathname === `/guild/${guild.id}` ? ' active' : ''}${dragging ? ' dragging' : ''}`}
              style={dragging ? { transform: `translateY(${drag.dy}px)` } : shift ? { transform: `translateY(${shift * 100}%) translateY(${shift * 16}px)` } : undefined}
              {...itemProps(guild.id)}
            >
              <span className={`dot${unreadGuildIds.has(guild.id) ? ' visible' : ''}`}></span>
              <NavLink to={`/guild/${guild.id}`} className="nav-icon rail-guild" aria-label={guild.name} title={guild.name} draggable={false}>
                <GuildIcon guild={guild} />
              </NavLink>
              {inVoice && (
                <span
                  className={`rail-voice-badge${inVoice === 'self' ? ' self' : ''}${guildMentions[guild.id] > 0 ? ' above' : ''}`}
                  aria-label={t(inVoice === 'self' ? 'app.sidebar.inVoice' : 'app.sidebar.othersInVoice')}
                >
                  <FontAwesomeIcon icon={faVolumeHigh} />
                </span>
              )}
              {guildMentions[guild.id] > 0 && (
                <span className="mention-badge rail-mention-badge" aria-label={t('app.sidebar.mentions', { count: guildMentions[guild.id] })}>
                  {guildMentions[guild.id] > 99 ? '99+' : guildMentions[guild.id]}
                </span>
              )}
            </div>
          );
        })}
      </nav>

      <div className="nav-item">
        <button type="button" className="nav-icon rail-add" aria-label={t('app.sidebar.addGuild')} title={t('app.sidebar.addGuild')} onClick={() => setAdding(true)}>
          <FontAwesomeIcon icon={faPlus} />
        </button>
      </div>

      {/* A calendar is planned; its icon goes here. */}

      {adding && <AddGuildDialog onClose={() => setAdding(false)} />}
      {menu && (
        <GuildMenu
          guildId={menu.guildId}
          user={user}
          anchor={menu.anchor}
          sheet={isMobile}
          onDialog={(type) => setDialog({ type, guildId: menu.guildId })}
          onClose={closeMenu}
        />
      )}
      {dialogGuild && dialog.type === 'invite' && <InviteDialog guild={dialogGuild} onClose={closeDialog} />}
      {dialogGuild && dialog.type === 'settings' && <GuildSettingsDialog guild={dialogGuild} user={user} onClose={closeDialog} />}
      {dialogGuild && dialog.type === 'audit' && <AuditLogDialog guild={dialogGuild} user={user} onClose={closeDialog} />}
      {dialogGuild && dialog.type === 'leaderboard' && <LeaderboardDialog guild={dialogGuild} user={user} onClose={closeDialog} />}
      {dialogGuild && dialog.type === 'leave' && (
        <ConfirmDialog
          title={t('app.sidebar.leaveGuild.title', { name: dialogGuild.name })}
          message={t('app.sidebar.leaveGuild.message', { name: dialogGuild.name })}
          confirmLabel={t('app.sidebar.leaveGuild.confirm')}
          onConfirm={async () => {
            await leaveGuild(dialogGuild.id);
            guildList.removeGuild(dialogGuild.id);
          }}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
