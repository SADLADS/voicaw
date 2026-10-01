import React, { useContext } from 'react';
import {
  faBell,
  faBellSlash,
  faCheckDouble,
  faClone,
  faGear,
  faLink,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../../contexts';
import {
  markChannelReadToLatest,
  muteChannel,
  setChannelNotifications,
  unmuteChannel,
} from '../../services/guildService';
import { channelLink } from '../../utils/guildDisplay';
import { MUTE_DURATIONS, NOTIFY_LEVEL_LABELS, mutedUntilText } from '../../utils/channelMutes';
import { useDateFormat } from '../../utils/dateFormat';
import { PERMISSIONS, has } from '../../utils/permissions';
import ChannelIcon from './ChannelIcon';
import ContextMenu from './ContextMenu';

// A channel's menu in the channel list (right-click, or touch and hold on a phone), like
// Discord's: Mark As Read, Mute Channel (for how long) or Unmute, its Notification Settings
// (your own level for it, or the guild's), Copy Link; with Manage Channels also Edit,
// Duplicate (a copy with the same permissions: `onClone`) and Delete. Someone with only
// Manage Webhooks gets Edit (the webhooks tab). Voice channels have no messages, so no read,
// mute or notification items; list channels no read item.
export default function ChannelMenu({ guild, channel, anchor, sheet, onEdit, onClone, onDelete, onClose }) {
  useDateFormat();
  const { guildList } = useContext(LayoutContext);
  const chat = channel.type === 'text' || channel.type === 'doc';
  const mute = guildList.mutes?.[channel.id];
  const ownLevel = guildList.channelLevels?.[channel.id]?.level ?? null;
  const guildLevel = guild.my_notify_level ?? 'mentions';
  const unread = guildList.unread?.find((u) => u.channel_id === channel.id && (u.count > 0 || u.mentions > 0));
  const managesChannels = has(guild.my_permissions, PERMISSIONS.MANAGE_CHANNELS);
  const editsWebhooks = channel.type === 'text' && has(channel.my_permissions, PERMISSIONS.MANAGE_WEBHOOKS);

  const items = [];
  if (chat && unread) {
    items.push({
      key: 'read',
      label: 'Mark As Read',
      icon: faCheckDouble,
      onSelect: async () => {
        await markChannelReadToLatest(channel.id);
        guildList.clearUnread(channel.id);
      },
    }, { separator: true });
  }
  if (chat) {
    items.push(mute
      ? {
        key: 'mute',
        label: 'Unmute Channel',
        hint: mutedUntilText(mute.until),
        icon: faBell,
        onSelect: async () => guildList.applyMute(await unmuteChannel(channel.id)),
      }
      : {
        key: 'mute',
        label: 'Mute Channel',
        icon: faBellSlash,
        submenu: {
          title: 'Mute Channel',
          items: MUTE_DURATIONS.map(([label, duration]) => ({
            key: `mute-${duration}`,
            label,
            onSelect: async () => guildList.applyMute(await muteChannel(channel.id, duration)),
          })),
        },
      });
    const setLevel = (level) => async () => guildList.applyChannelLevel(await setChannelNotifications(channel.id, level));
    items.push({
      key: 'notifications',
      label: 'Notification Settings',
      hint: ownLevel ? NOTIFY_LEVEL_LABELS[ownLevel] : 'Guild default',
      icon: faBell,
      submenu: {
        title: 'Notification Settings',
        items: [
          {
            key: 'level-default',
            label: 'Use Guild Default',
            hint: NOTIFY_LEVEL_LABELS[guildLevel],
            checked: ownLevel === null,
            onSelect: setLevel(null),
          },
          ...Object.entries(NOTIFY_LEVEL_LABELS).map(([level, label]) => ({
            key: `level-${level}`,
            label,
            checked: ownLevel === level,
            onSelect: setLevel(level),
          })),
        ],
      },
    }, { separator: true });
  }
  items.push({
    key: 'link',
    label: 'Copy Link',
    icon: faLink,
    onSelect: async () => {
      await navigator.clipboard.writeText(channelLink(guild.id, channel.id));
      return 'Link copied';
    },
  });
  if (managesChannels || editsWebhooks) {
    items.push({ separator: true }, { key: 'edit', label: 'Edit Channel', icon: faGear, onSelect: onEdit });
  }
  if (managesChannels) {
    items.push(
      { key: 'clone', label: 'Duplicate Channel', icon: faClone, onSelect: onClone },
      { key: 'delete', label: 'Delete Channel', icon: faTrash, danger: true, onSelect: onDelete },
    );
  }

  return (
    <ContextMenu
      title={<><ChannelIcon channel={channel} className="context-sheet-icon" /> {channel.name}</>}
      label={`#${channel.name}`}
      items={items}
      anchor={anchor}
      sheet={sheet}
      onClose={onClose}
    />
  );
}
