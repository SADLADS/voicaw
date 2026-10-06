import React, { useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { faBell, faBellSlash, faCheckDouble, faPhone, faThumbtack } from '@fortawesome/free-solid-svg-icons';
import { ConfigContext, LayoutContext } from '../contexts';
import { markMessagesRead, setConversationSetting } from '../services/dmService';
import { markGroupReadToLatest } from '../services/groupService';
import { markBotDmRead } from '../services/botDmService';
import { startCall, startGroupCall } from '../voice/callClient';
import { useCall, useGroupCall } from '../hooks/useCall';
import { MUTE_DURATIONS, mutedUntilText } from '../utils/channelMutes';
import { useDateFormat } from '../utils/dateFormat';
import { showContent } from '../utils/mobilePanes';
import ContextMenu from './ContextMenu';
import { t } from '../i18n';

// A conversation's menu in the DM list (right-click, or touch and hold on a phone): Mark As
// Read, Start Call (or Join Call, for a group whose call is on), Pin / Unpin (to the top of the
// list) and Mute Conversation (for how long) / Unmute, like Discord's. Pins and mutes are your
// own, kept by the server so your other devices follow (useConversationSettings). A call opens
// the chat and rings from there (the click counts as the gesture its sound needs).
// `person` (a DM list row), `group` (a group list row) or `botDm` (a conversation with a bot: no
// calls), `title` the name shown on a phone.
export default function DmMenu({ person, group, botDm, title, unread, anchor, sheet, onClose }) {
  useDateFormat();
  const navigate = useNavigate();
  const { voiceEnabled } = useContext(ConfigContext);
  const { conversationSettings, fetchUnreadMessages, groupList, botDmList } = useContext(LayoutContext);
  const call = useCall();
  const groupCall = useGroupCall(group?.id);
  const kind = group ? 'group' : botDm ? 'bot' : 'dm';
  const target = group ? group.id : botDm ? botDm.id : person.id;
  const setting = conversationSettings.get(kind, target);
  const change = (changes) => async () => conversationSettings.apply(await setConversationSetting(kind, target, changes));

  const items = [];
  if (unread) {
    items.push({
      key: 'read',
      label: t('chat.dmMenu.markRead'),
      icon: faCheckDouble,
      onSelect: async () => {
        if (group) {
          await markGroupReadToLatest(group.id);
          groupList.clearUnread(group.id);
        } else if (botDm) {
          await markBotDmRead(botDm.id);
          botDmList.clearUnread(botDm.id);
        } else {
          await markMessagesRead(person.id);
          await fetchUnreadMessages();
        }
      },
    }, { separator: true });
  }
  if (voiceEnabled && !call && !botDm && !person?.deleted_at) {
    items.push({
      key: 'call',
      label: group && groupCall ? t('chat.dmMenu.joinCall') : t('chat.dmMenu.startCall'),
      icon: faPhone,
      onSelect: () => {
        navigate(group ? `/dm/g/${group.id}` : `/dm/${person.id}`);
        showContent();
        if (group) startGroupCall(group.id);
        else startCall(person);
      },
    }, { separator: true });
  }
  items.push({
    key: 'pin',
    label: setting.pinned_at != null ? t('chat.dmMenu.unpin') : t('chat.dmMenu.pin'),
    icon: faThumbtack,
    onSelect: change({ pinned: setting.pinned_at == null }),
  });
  items.push(setting.muted
    ? { key: 'mute', label: t('chat.dmMenu.unmute'), hint: mutedUntilText(setting.mute_until), icon: faBell, onSelect: change({ mute: false }) }
    : {
      key: 'mute',
      label: t('chat.dmMenu.mute'),
      icon: faBellSlash,
      submenu: {
        title: t('chat.dmMenu.mute'),
        items: MUTE_DURATIONS.map(([label, duration]) => ({ key: `mute-${duration}`, label, onSelect: change({ mute: { duration } }) })),
      },
    });

  return <ContextMenu title={title} label={title} items={items} anchor={anchor} sheet={sheet} onClose={onClose} />;
}
