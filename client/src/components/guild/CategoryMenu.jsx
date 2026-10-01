import React, { useContext } from 'react';
import {
  faCheckDouble,
  faChevronDown,
  faChevronRight,
  faGear,
  faPlus,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../../contexts';
import { markChannelReadToLatest } from '../../services/guildService';
import { PERMISSIONS, has } from '../../utils/permissions';
import ContextMenu from './ContextMenu';

// A category's menu in the channel list (right-click, or touch and hold on a phone): Mark As
// Read (every channel in it you can see), Collapse / Expand; with Manage Channels also Edit,
// Create Channel (in it) and Delete (its channels stay, uncategorised).
export default function CategoryMenu({ guild, category, channels, collapsed, anchor, sheet, onToggle, onEdit, onCreateChannel, onDelete, onClose }) {
  const { guildList } = useContext(LayoutContext);
  const ids = new Set(channels.filter((c) => c.type === 'text' || c.type === 'doc').map((c) => c.id));
  const unread = (guildList.unread ?? []).filter((u) => ids.has(u.channel_id) && (u.count > 0 || u.mentions > 0));
  const items = [];
  if (unread.length) {
    items.push({
      key: 'read',
      label: 'Mark As Read',
      icon: faCheckDouble,
      onSelect: async () => {
        await Promise.all(unread.map((u) => markChannelReadToLatest(u.channel_id)));
        for (const u of unread) guildList.clearUnread(u.channel_id);
      },
    }, { separator: true });
  }
  items.push({
    key: 'collapse',
    label: collapsed ? 'Expand Category' : 'Collapse Category',
    icon: collapsed ? faChevronRight : faChevronDown,
    onSelect: onToggle,
  });
  if (has(guild.my_permissions, PERMISSIONS.MANAGE_CHANNELS)) {
    items.push(
      { separator: true },
      { key: 'edit', label: 'Edit Category', icon: faGear, onSelect: onEdit },
      { key: 'create', label: 'Create Channel', icon: faPlus, onSelect: onCreateChannel },
      { key: 'delete', label: 'Delete Category', icon: faTrash, danger: true, onSelect: onDelete },
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
