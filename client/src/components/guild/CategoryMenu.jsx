import React, { useContext } from 'react';
import {
  faBell,
  faBellSlash,
  faCheckDouble,
  faChevronDown,
  faChevronRight,
  faGear,
  faPlus,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../../contexts';
import { markChannelReadToLatest, muteCategory, unmuteCategory } from '../../services/guildService';
import { MUTE_DURATIONS, mutedUntilText } from '../../utils/channelMutes';
import { useDateFormat } from '../../utils/dateFormat';
import { PERMISSIONS, has } from '../../utils/permissions';
import { copyIdItem } from '../../utils/copyId';
import ContextMenu from '../ContextMenu';
import { t } from '../../i18n';

// A category's menu in the channel list (right-click, or touch and hold on a phone): Mark As
// Read (every channel in it you can see), Mute Category (for how long: every channel in it and
// their threads, as muting each would) / Unmute Category, Collapse / Expand, Copy Category ID (the bot API's); with Manage Channels also Edit,
// Create Channel (in it) and Delete (its channels stay, uncategorised).
export default function CategoryMenu({ guild, category, channels, collapsed, anchor, sheet, onToggle, onEdit, onCreateChannel, onDelete, onClose }) {
  useDateFormat();
  const { guildList } = useContext(LayoutContext);
  const mute = guildList.categoryMutes?.[category.id];
  const ids = new Set(channels.filter((c) => ['text', 'voice', 'doc'].includes(c.type)).map((c) => c.id));
  const unread = (guildList.unread ?? []).filter((u) => ids.has(u.channel_id) && (u.count > 0 || u.mentions > 0));
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
  items.push(mute
    ? {
      key: 'mute',
      label: t('guildAdmin.categoryMenu.unmute'),
      hint: mutedUntilText(mute.until),
      icon: faBell,
      onSelect: async () => guildList.applyCategoryMute(await unmuteCategory(guild.id, category.id)),
    }
    : {
      key: 'mute',
      label: t('guildAdmin.categoryMenu.mute'),
      icon: faBellSlash,
      submenu: {
        title: t('guildAdmin.categoryMenu.mute'),
        items: MUTE_DURATIONS.map(([label, duration]) => ({
          key: `mute-${duration}`,
          label,
          onSelect: async () => guildList.applyCategoryMute(await muteCategory(guild.id, category.id, duration)),
        })),
      },
    });
  items.push({
    key: 'collapse',
    label: collapsed ? t('guildAdmin.categoryMenu.expand') : t('guildAdmin.categoryMenu.collapse'),
    icon: collapsed ? faChevronRight : faChevronDown,
    onSelect: onToggle,
  }, copyIdItem('category', category.id));
  if (has(guild.my_permissions, PERMISSIONS.MANAGE_CHANNELS)) {
    items.push(
      { separator: true },
      { key: 'edit', label: t('guildAdmin.categoryMenu.edit'), icon: faGear, onSelect: onEdit },
      { key: 'create', label: t('guildAdmin.categoryMenu.createChannel'), icon: faPlus, onSelect: onCreateChannel },
      { key: 'delete', label: t('guildAdmin.categoryMenu.delete'), icon: faTrash, danger: true, onSelect: onDelete },
    );
  }

  return (
    <ContextMenu
      title={category.name}
      label={category.name}
      items={items}
      anchor={anchor}
      sheet={sheet}
      onClose={onClose}
    />
  );
}
