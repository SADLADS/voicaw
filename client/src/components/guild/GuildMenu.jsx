import React, { useContext, useEffect } from 'react';
import {
  faBell,
  faCheckDouble,
  faClipboardList,
  faGear,
  faLink,
  faRightFromBracket,
  faTrophy,
  faUserPlus,
} from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../../contexts';
import { markChannelReadToLatest, setGuildNotifications } from '../../services/guildService';
import { guildLink } from '../../utils/guildDisplay';
import { copyIdItem } from '../../utils/copyId';
import { NOTIFY_LEVEL_LABELS } from '../../utils/channelMutes';
import { PERMISSIONS, has } from '../../utils/permissions';
import { levelsOn } from '../../utils/levels';
import ContextMenu from '../ContextMenu';
import { t } from '../../i18n';

// A guild's menu on the rail (right-click its icon, or touch and hold on a phone): the guild
// menu's options that aren't about channels: Mark As Read, Invite People, Notification Settings
// (your level for the guild), Guild Settings, Audit Log, Copy Link, Copy Guild ID and Leave Guild, each as your
// permissions allow. The dialogs are the rail's (`onDialog(type)`: 'invite' | 'settings' |
// 'audit' | 'leave'), since the menu closes on a pick. Waits for the guild's layout (for your
// permissions) if it isn't loaded yet.
export default function GuildMenu({ guildId, user, anchor, sheet, onDialog, onClose }) {
  const { guildList } = useContext(LayoutContext);
  const guild = guildList.layouts[guildId];
  const summary = guildList.guilds.find((g) => g.id === guildId);
  const { loadGuild } = guildList;

  useEffect(() => {
    if (!guild) loadGuild(guildId).catch(() => onClose());
  }, [guild, guildId, loadGuild, onClose]);

  if (!guild) return null;
  const can = (bit) => has(guild.my_permissions, bit);
  const unread = guildList.unread.filter((u) => u.guild_id === guildId && (u.count > 0 || u.mentions > 0));
  const level = guild.my_notify_level ?? 'mentions';
  const opensSettings = can(PERMISSIONS.MANAGE_GUILD) || can(PERMISSIONS.MANAGE_ROLES) ||
    can(PERMISSIONS.MANAGE_EMOJIS) || can(PERMISSIONS.BAN_MEMBERS);

  const items = [];
  if (unread.length) {
    items.push({
      key: 'read',
      label: t('guildAdmin.categoryMenu.markAsRead'),
      icon: faCheckDouble,
      onSelect: async () => {
        await Promise.all(unread.map((u) => markChannelReadToLatest(u.channel_id)));
        for (const u of unread) guildList.clearUnread(u.channel_id);
      },
    }, { separator: true });
  }
  if (can(PERMISSIONS.CREATE_INVITE)) {
    items.push({ key: 'invite', label: t('guildAdmin.guildMenu.invite'), icon: faUserPlus, onSelect: () => onDialog('invite') });
  }
  items.push({
    key: 'notifications',
    label: t('guildAdmin.guildMenu.notifications'),
    hint: NOTIFY_LEVEL_LABELS[level],
    icon: faBell,
    submenu: {
      title: t('guildAdmin.guildMenu.notifications'),
      items: Object.entries(NOTIFY_LEVEL_LABELS).map(([value, label]) => ({
        key: `level-${value}`,
        label,
        checked: level === value,
        onSelect: async () => {
          await setGuildNotifications(guildId, value);
          await loadGuild(guildId);
        },
      })),
    },
  });
  if (opensSettings) items.push({ key: 'settings', label: t('guildAdmin.guildMenu.settings'), icon: faGear, onSelect: () => onDialog('settings') });
  if (levelsOn(guild)) items.push({ key: 'leaderboard', label: t('levels.leaderboard.title'), icon: faTrophy, onSelect: () => onDialog('leaderboard') });
  if (can(PERMISSIONS.VIEW_AUDIT_LOG)) items.push({ key: 'audit', label: t('guildAdmin.auditLog.title'), icon: faClipboardList, onSelect: () => onDialog('audit') });
  items.push({
    key: 'link',
    label: t('guildAdmin.guildMenu.copyLink'),
    icon: faLink,
    onSelect: async () => {
      await navigator.clipboard.writeText(guildLink(guildId));
      return t('guildAdmin.guildMenu.linkCopied');
    },
  }, copyIdItem('guild', guildId));
  if (guild.owner !== user?.id) {
    items.push(
      { separator: true },
      { key: 'leave', label: t('guildAdmin.guildMenu.leave'), icon: faRightFromBracket, danger: true, onSelect: () => onDialog('leave') },
    );
  }

  const name = summary?.name ?? guild.name;
  return <ContextMenu title={name} label={name} items={items} anchor={anchor} sheet={sheet} onClose={onClose} />;
}
