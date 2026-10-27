import React, { useContext } from 'react';
import { faCheckDouble, faFolderOpen, faGear } from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../../contexts';
import { markChannelReadToLatest } from '../../services/guildService';
import { folderLabel } from '../../utils/guildFolders';
import ContextMenu from '../ContextMenu';
import { t } from '../../i18n';

// A guild folder's menu on the rail (right-click it, or touch and hold on a phone), as Discord's:
// Mark Folder As Read (every unread channel in its guilds), Folder Settings (`onSettings`: the
// rail's dialog, since the menu closes on a pick) and Ungroup (its guilds back on the rail).
export default function FolderMenu({ folder, anchor, sheet, onSettings, onClose }) {
  const { guildList } = useContext(LayoutContext);
  const ids = new Set(folder.guilds.map((g) => g.id));
  const unread = guildList.unread.filter((u) => ids.has(u.guild_id) && (u.count > 0 || u.mentions > 0));

  const items = [];
  if (unread.length) {
    items.push({
      key: 'read',
      label: t('app.sidebar.folder.markAsRead'),
      icon: faCheckDouble,
      onSelect: async () => {
        await Promise.all(unread.map((u) => markChannelReadToLatest(u.channel_id)));
        for (const u of unread) guildList.clearUnread(u.channel_id);
      },
    }, { separator: true });
  }
  items.push(
    { key: 'settings', label: t('app.sidebar.folder.settings'), icon: faGear, onSelect: onSettings },
    {
      key: 'ungroup',
      label: t('app.sidebar.folder.ungroup'),
      icon: faFolderOpen,
      onSelect: () => guildList.saveRail(guildList.rail.flatMap((item) => (item.type === 'folder' && item.id === folder.id
        ? item.guilds.map((guild) => ({ type: 'guild', id: guild.id, guild }))
        : [item]))),
    },
  );

  const label = folderLabel(folder);
  return <ContextMenu title={label} label={label} items={items} anchor={anchor} sheet={sheet} onClose={onClose} />;
}
