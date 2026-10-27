import React, { useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Icon } from './Icon';
import { faFolder, faPlus, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import GuildIcon from './guild/GuildIcon';
import Avatar from './Avatar';
import GroupPicture from './group/GroupPicture';
import '../assets/css/guilds.css';
import '../assets/css/groups.css';
import AddGuildDialog from './guild/AddGuildDialog';
import GuildMenu from './guild/GuildMenu';
import FolderMenu from './guild/FolderMenu';
import FolderSettingsDialog from './guild/FolderSettingsDialog';
import InviteDialog from './guild/InviteDialog';
import GuildSettingsDialog from './guild/GuildSettingsDialog';
import AuditLogDialog from './guild/AuditLogDialog';
import LeaderboardDialog from './guild/LeaderboardDialog';
import ConfirmDialog from './guild/ConfirmDialog';
import { InteractionContext, LayoutContext } from '../contexts';
import { leaveGuild } from '../services/guildService';
import { useRailDrag } from '../hooks/useRailDrag';
import { useVoice } from '../hooks/useVoice';
import { t } from '../i18n';
import { displayName } from '../utils/profiles';
import { groupTitle } from '../utils/groupDisplay';
import { showContent } from '../utils/mobilePanes';
import { lastDm } from '../utils/lastChat';
import { colorToHex } from '../utils/permissions';
import { folderLabel, loadOpenFolders, rowKey, saveOpenFolders } from '../utils/guildFolders';

// The guild rail down the left (like Discord's): the bird (DMs), then each guild (a pill on the
// left marks unread messages, a taller one the open guild), then "+" to create or join one.
// `unreadGuildIds` is a Set of guild ids with unread messages, `guildMentions` ({ guildId:
// count }) how many of them mention you (a red badge on the icon). `guildVoice` ({ guildId:
// 'self' | 'others' }) puts a speaker on guilds with someone in a voice channel you can see:
// grey, or green when you're in one there (this device counts as soon as it connects).
// `rail` is the guilds and folders of guilds (utils/guildFolders.js) in order. Guilds and folders
// can be dragged into a new order, a guild dropped on another to make a folder, into or out of
// one (hold, then drag, on touch screens; hooks/useRailDrag.js); `onChangeRail(items)` saves it.
// A folder (as Discord's) shows its first four guilds small while closed, with their unread pill,
// mentions and speaker together, and opens on a click (per device) to show them below it.
// Right-clicking a guild or folder (touch, hold and lift on a phone) opens its menu (GuildMenu,
// FolderMenu), whose dialogs live here.
// `unreadChats` (utils/latestUnread.js unreadChats: [{ key, userId, path, count }], newest first)
// are the DMs, groups and bot DMs with unread messages: each gets its newest sender's picture
// under the bird (a group its own picture, or its members' two as in the DM list), with how many
// are unread, opening that chat (as in Discord); the separator moves down under them.
export default function Sidebar({ user, hasUnreadDms, unreadChats = [], rail = [], unreadGuildIds = new Set(), guildMentions = {}, guildVoice = {}, onChangeRail }) {
  const location = useLocation();
  const { guildList } = useContext(LayoutContext) ?? {};
  const { isMobile } = useContext(InteractionContext);
  const myVoice = useVoice();
  const myVoiceGuildId = myVoice.status === 'idle' ? null : myVoice.guildId;
  const [adding, setAdding] = useState(false);
  // { key, anchor } while a guild's or folder's menu is open (key: 'g:<id>' or 'f:<id>');
  // { type, guildId } for one of a guild's dialogs, { type: 'folder', folderId } a folder's.
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeDialog = () => setDialog(null);
  const [openFolders, setOpenFolders] = useState(loadOpenFolders);
  const toggleFolder = (id) => setOpenFolders((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saveOpenFolders(next);
    return next;
  });
  const { drag, rowProps, groupRef } = useRailDrag(rail, openFolders, (items) => onChangeRail?.(items), {
    onMenu: guildList ? (key, anchor) => setMenu({ key, anchor }) : undefined,
  });
  const dialogGuild = dialog?.guildId != null ? guildList?.layouts[dialog.guildId] : null;
  const folderById = (id) => rail.find((item) => item.type === 'folder' && item.id === id);
  const menuFolder = menu?.key.startsWith('f:') ? folderById(Number(menu.key.slice(2))) : null;
  const dialogFolder = dialog?.type === 'folder' ? folderById(dialog.folderId) : null;
  // A folder that's gone (ungrouped on another device) closes its menu and dialog.
  useEffect(() => {
    if (menu?.key.startsWith('f:') && !menuFolder) setMenu(null);
  }, [menu, menuFolder]);

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

  const isGuildActive = (guildId) => isActivePath(`/guild/${guildId}/`) || location.pathname === `/guild/${guildId}`;
  const voiceIn = (guildId) => (myVoiceGuildId != null && String(myVoiceGuildId) === String(guildId) ? 'self' : guildVoice[guildId]);
  // Where a dragged item would land, drawn on the row it's beside or onto.
  const dropClass = (key) => {
    const target = drag?.target;
    if (!target) return '';
    if ((target.type === 'before' || target.type === 'after') && target.key === key) return ` drop-${target.type}`;
    if ((target.type === 'combine' || target.type === 'into') && rowKey(target.type === 'into' ? 'folder' : 'guild', target.id) === key) return ' drop-onto';
    return '';
  };
  // Over a guild or folder it would join, it shrinks so the ring there shows.
  const joining = drag?.target.type === 'combine' || drag?.target.type === 'into';
  const dragStyle = (key) => (drag?.key === key ? { transform: `translateY(${drag.dy}px)${joining ? ' scale(0.7)' : ''}` } : undefined);

  const badges = (inVoice, mentions) => (
    <>
      {inVoice && (
        <span
          className={`rail-voice-badge${inVoice === 'self' ? ' self' : ''}${mentions > 0 ? ' above' : ''}`}
          aria-label={t(inVoice === 'self' ? 'app.sidebar.inVoice' : 'app.sidebar.othersInVoice')}
        >
          <Icon icon={faVolumeHigh} />
        </span>
      )}
      {mentions > 0 && (
        <span className="mention-badge rail-mention-badge" aria-label={t('app.sidebar.mentions', { count: mentions })}>
          {mentions > 99 ? '99+' : mentions}
        </span>
      )}
    </>
  );

  const renderGuild = (guild) => {
    const key = rowKey('guild', guild.id);
    const active = isGuildActive(guild.id);
    return (
      <div
        key={key}
        className={`nav-item${active ? ' active' : ''}${drag?.key === key ? ' dragging' : ''}${dropClass(key)}`}
        style={dragStyle(key)}
        {...rowProps(key)}
      >
        <span className={`dot${unreadGuildIds.has(guild.id) ? ' visible' : ''}`}></span>
        <NavLink to={`/guild/${guild.id}`} className="nav-icon rail-guild" onClick={stayIfIn(active)} aria-label={guild.name} title={guild.name} draggable={false}>
          <GuildIcon guild={guild} />
        </NavLink>
        {badges(voiceIn(guild.id), guildMentions[guild.id])}
      </div>
    );
  };

  const renderFolder = (folder) => {
    const key = rowKey('folder', folder.id);
    const open = openFolders.has(folder.id);
    const label = folderLabel(folder);
    const ids = folder.guilds.map((g) => g.id);
    // Closed, it stands for its guilds: the open one, unread, mentions, voice.
    const active = !open && ids.some(isGuildActive);
    const unread = !open && ids.some((id) => unreadGuildIds.has(id));
    const mentions = open ? 0 : ids.reduce((sum, id) => sum + (guildMentions[id] ?? 0), 0);
    const voices = open ? [] : ids.map(voiceIn);
    const inVoice = voices.includes('self') ? 'self' : voices.find(Boolean);
    return (
      <div
        key={key}
        ref={groupRef(folder.id)}
        className={`rail-folder${open ? ' open' : ''}${drag?.key === key ? ' dragging' : ''}`}
        style={{ ...(folder.color != null ? { '--rail-folder-color': colorToHex(folder.color) } : {}), ...dragStyle(key) }}
      >
        <div className={`nav-item rail-folder-top${active ? ' active' : ''}${dropClass(key)}`} {...rowProps(key)}>
          <span className={`dot${unread ? ' visible' : ''}`}></span>
          <button
            type="button"
            className="nav-icon rail-folder-icon"
            aria-expanded={open}
            aria-label={label}
            title={label}
            onClick={() => toggleFolder(folder.id)}
          >
            {open ? <Icon icon={faFolder} /> : (
              <span className="rail-folder-guilds">
                {folder.guilds.slice(0, 4).map((guild) => <GuildIcon key={guild.id} guild={guild} />)}
              </span>
            )}
          </button>
          {badges(inVoice, mentions)}
        </div>
        {open && folder.guilds.map(renderGuild)}
      </div>
    );
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

      {unreadChats.map((chat) => {
        const { group } = chat;
        const label = group
          ? t('app.sidebar.unreadInGroup', { name: displayName(chat.userId), group: groupTitle(group, user) })
          : t('app.sidebar.unreadFrom', { name: displayName(chat.userId) });
        const others = group ? (group.members ?? []).filter((m) => m.id !== user?.id) : [];
        return (
          <div key={chat.key} className="nav-item rail-unread-chat">
            <NavLink
              to={chat.path}
              className={`nav-icon rail-dm-unread${group ? ' rail-group' : ''}`}
              onClick={showContent}
              aria-label={label}
              title={label}
            >
              {group ? (
                <GroupPicture groupId={group.id} picture={group.picture} className="group-picture">
                  <span className="group-avatar">
                    {others.slice(0, 2).map((m) => <span key={m.id}><Avatar userId={m.id} alt="" className="group-avatar-img" /></span>)}
                  </span>
                </GroupPicture>
              ) : (
                <Avatar userId={chat.userId} />
              )}
            </NavLink>
            <span className="mention-badge rail-mention-badge" aria-label={t('app.sidebar.unreadCount', { count: chat.count })}>
              {chat.count > 9 ? '9+' : chat.count}
            </span>
          </div>
        );
      })}

      {rail.length > 0 && <div className="rail-separator" />}

      <nav className={`rail-guilds${drag ? ' reordering' : ''}${drag?.target.type === 'end' ? ' drop-end' : ''}`} aria-label={t('app.sidebar.guilds')}>
        {rail.map((item) => (item.type === 'guild' ? renderGuild(item.guild) : renderFolder(item)))}
      </nav>

      <div className="nav-item">
        <button type="button" className="nav-icon rail-add" aria-label={t('app.sidebar.addGuild')} title={t('app.sidebar.addGuild')} onClick={() => setAdding(true)}>
          <Icon icon={faPlus} />
        </button>
      </div>

      {/* A calendar is planned; its icon goes here. */}

      {adding && <AddGuildDialog onClose={() => setAdding(false)} />}
      {menu?.key.startsWith('g:') && (
        <GuildMenu
          guildId={Number(menu.key.slice(2))}
          user={user}
          anchor={menu.anchor}
          sheet={isMobile}
          onDialog={(type) => setDialog({ type, guildId: Number(menu.key.slice(2)) })}
          onClose={closeMenu}
        />
      )}
      {menuFolder && (
        <FolderMenu
          folder={menuFolder}
          anchor={menu.anchor}
          sheet={isMobile}
          onSettings={() => setDialog({ type: 'folder', folderId: menuFolder.id })}
          onClose={closeMenu}
        />
      )}
      {dialogFolder && <FolderSettingsDialog folder={dialogFolder} onClose={closeDialog} />}
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
