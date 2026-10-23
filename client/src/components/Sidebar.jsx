import React, { useCallback, useContext, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Icon } from './Icon';
import { faPlus, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
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
import { showContent } from '../utils/mobilePanes';
import { lastDm } from '../utils/lastChat';

// The guild rail down the left (like Discord's): the bird (DMs), then each guild (a pill on the
// left marks unread messages, a taller one the open guild), then "+" to create or join one.
// `unreadGuildIds` is a Set of guild ids with unread messages, `guildMentions` ({ guildId:
// count }) how many of them mention you (a red badge on the icon). `guildVoice` ({ guildId:
// 'self' | 'others' }) puts a speaker on guilds with someone in a voice channel you can see:
// grey, or green when you're in one there (this device counts as soon as it connects). Guilds can be dragged into a
// new order (hold, then drag, on touch screens); `onReorderGuilds(ids)` saves it. Right-clicking
// a guild (touch, hold and lift on a phone) opens its menu (GuildMenu), whose dialogs live here.
// `unreadChats` (utils/latestUnread.js unreadChats: [{ key, userId, path, count }], newest first)
// are the DMs, groups and bot DMs with unread messages: each gets its newest sender's picture
// under the bird, with how many are unread, opening that chat (as in Discord); the separator
// moves down under them.
export default function Sidebar({ user, hasUnreadDms, unreadChats = [], guilds = [], unreadGuildIds = new Set(), guildMentions = {}, guildVoice = {}, onReorderGuilds }) {
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
  // Clicking the DMs or the guild you're already in does nothing (as in Discord): following the
  // link would open bare /dm or /guild/:id, which shows an empty page for a moment before
  // redirecting to a conversation or channel.
  const stayIfIn = (active) => (e) => {
    if (active) e.preventDefault();
  };

  // The bird logo is the DM button. It faces left in the encrypted chats (DMs, group DMs, notes)
  // and Friends, and turns round to face right everywhere else, bot DMs included (they aren't
  // encrypted). A click makes it pop, restarting on every click so quick clicks each get their
  // own; one while already on the DM side goes nowhere (as stayIfIn). The pop is on the link and
  // the turn on the bird inside it, so one never cuts the other short.
  const inDms = isActivePath('/dm');
  const encrypted = inDms && !isActivePath('/dm/b/');
  const clickBird = (e) => {
    e.currentTarget.animate?.(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
      { duration: 160, easing: 'ease-out' },
    );
    if (inDms) e.preventDefault();
  };

  return (
    <div
      className="sidebar d-flex flex-column align-items-center"
      style={{ width: '72px' }}
    >
      <div className={`nav-item ${inDms ? 'active' : ''}`}>
      <span className={`dot${hasUnreadDms ? ' visible' : ''}`}></span>
        {/* Back to the DM page last open (utils/lastChat.js), checked as a reopened chat is. */}
        <NavLink to={lastDm() ?? '/dm'} state={{ restoredChat: true }} className="rail-bird" onClick={clickBird} aria-label={t('app.sidebar.directMessages')} title={t('app.sidebar.directMessages')}>
          {/* The bird drawn as a mask in the theme's --vc-logo colour (voicaw.css). */}
          <span className={`rail-logo${encrypted ? '' : ' turned'}`} />
        </NavLink>
      </div>

      {unreadChats.map((chat) => (
        <div key={chat.key} className="nav-item rail-unread-chat">
          <NavLink
            to={chat.path}
            className="nav-icon rail-dm-unread"
            onClick={showContent}
            aria-label={t('app.sidebar.unreadFrom', { name: displayName(chat.userId) })}
            title={t('app.sidebar.unreadFrom', { name: displayName(chat.userId) })}
          >
            <Avatar userId={chat.userId} />
          </NavLink>
          <span className="mention-badge rail-mention-badge" aria-label={t('app.sidebar.unreadCount', { count: chat.count })}>
            {chat.count > 9 ? '9+' : chat.count}
          </span>
        </div>
      ))}

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
          const active = isActivePath(`/guild/${guild.id}/`) || location.pathname === `/guild/${guild.id}`;
          const inVoice = myVoiceGuildId != null && String(myVoiceGuildId) === String(guild.id) ? 'self' : guildVoice[guild.id];
          return (
            <div
              key={guild.id}
              className={`nav-item${active ? ' active' : ''}${dragging ? ' dragging' : ''}`}
              style={dragging ? { transform: `translateY(${drag.dy}px)` } : shift ? { transform: `translateY(${shift * 100}%) translateY(${shift * 16}px)` } : undefined}
              {...itemProps(guild.id)}
            >
              <span className={`dot${unreadGuildIds.has(guild.id) ? ' visible' : ''}`}></span>
              <NavLink to={`/guild/${guild.id}`} className="nav-icon rail-guild" onClick={stayIfIn(active)} aria-label={guild.name} title={guild.name} draggable={false}>
                <GuildIcon guild={guild} />
              </NavLink>
              {inVoice && (
                <span
                  className={`rail-voice-badge${inVoice === 'self' ? ' self' : ''}${guildMentions[guild.id] > 0 ? ' above' : ''}`}
                  aria-label={t(inVoice === 'self' ? 'app.sidebar.inVoice' : 'app.sidebar.othersInVoice')}
                >
                  <Icon icon={faVolumeHigh} />
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
          <Icon icon={faPlus} />
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
