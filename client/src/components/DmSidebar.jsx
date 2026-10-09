import React, { useCallback, useContext, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBellSlash, faNoteSticky, faThumbtack, faUserGroup, faUserFriends } from '@fortawesome/free-solid-svg-icons';
import { showContent } from '../utils/mobilePanes';
import { InteractionContext, LayoutContext } from '../contexts';
import { useLongPress } from '../hooks/useLongPress';
import DmMenu from './DmMenu';
import { usePresence } from '../hooks/usePresence';
import { lastSeenText, statusLabel } from '../utils/presence';
import { groupTitle } from '../utils/groupDisplay';
import StatusIcon from './StatusIcon';
import CustomStatus from './CustomStatus';
import NewGroupDialog from './group/NewGroupDialog';
import GroupPicture from './group/GroupPicture';
import { displayName, getProfile, nameOf, useProfiles } from '../utils/profiles';
import Avatar from './Avatar';
import { useFriends, visibleInDmList } from '../utils/friends';
import { t } from '../i18n';

// The conversation list: people, group DMs and conversations with bots (`botDms`, tagged BOT;
// not end-to-end encrypted, see BotDm), most recent first. `unreadDms`
// ([{ from_user_id, count }], from Layout) and each group's `unread` mark conversations with
// unread messages, except the one being viewed. The header's button makes a new group.
// People are your friends and whoever you have a conversation with (utils/friends.js), not
// everyone. Friends (the Friends page, with how many requests are waiting) and your notes (a DM
// to yourself) come first under the header, with a line between them and the conversations;
// they don't scroll with the list. Right-clicking a conversation (touch and
// hold on a phone) opens its menu (DmMenu: read, call, pin, mute); pinned ones come first, in
// the order they were pinned, and muted ones are dimmed, with no unread dot.
export default function DmSidebar({ user, users, groups = [], botDms = [], unreadDms = [] }) {
  useProfiles();
  const { id: activeId, groupId: activeGroupId, dmId: activeBotDmId } = useParams();
  const { isMobile } = useContext(InteractionContext);
  const { conversationSettings, groupList } = useContext(LayoutContext) ?? {};
  const { pathname } = useLocation();
  const notesActive = pathname === '/dm/notes';
  const friendsActive = pathname === '/dm/friends';
  const friends = useFriends();
  const people = users.filter((person) => visibleInDmList(friends, person, activeId));
  const presenceOf = usePresence();
  const [newGroup, setNewGroup] = useState(false);
  // { person | group, anchor } while a conversation's menu is open.
  const [menu, setMenu] = useState(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const unreadFrom = new Set(unreadDms.map((u) => String(u.from_user_id)));
  const settingOf = (kind, target) => conversationSettings?.get(kind, target) ?? { pinned_at: null, muted: false };

  // People keep the server's order among themselves (latest DM first); groups and conversations
  // with bots go in by their latest message. Pinned ones go first.
  const all = [];
  const byTime = [...groups.map((group) => ({ group, at: group.last_timestamp })), ...botDms.map((botDm) => ({ botDm, at: botDm.last_timestamp }))]
    .sort((a, b) => b.at - a.at);
  let g = 0;
  for (const person of people) {
    while (g < byTime.length && byTime[g].at >= (person.last_timestamp ?? 0)) all.push(byTime[g++]);
    all.push({ person });
  }
  while (g < byTime.length) all.push(byTime[g++]);
  const keyOf = (entry) => (entry.group ? `g-${entry.group.id}` : entry.botDm ? `b-${entry.botDm.id}` : String(entry.person.id));
  for (const entry of all) {
    entry.setting = entry.group ? settingOf('group', entry.group.id) : entry.botDm ? settingOf('bot', entry.botDm.id) : settingOf('dm', entry.person.id);
  }
  const entries = [
    ...all.filter((e) => e.setting.pinned_at != null).sort((a, b) => a.setting.pinned_at - b.setting.pinned_at),
    ...all.filter((e) => e.setting.pinned_at == null),
  ];

  // The menu: right-click on a computer, touch and hold on a phone (on whichever row the touch
  // started on).
  const pressed = useRef(null);
  const openMenu = (entry, anchor) => {
    if (conversationSettings) setMenu({ ...entry, anchor });
  };
  const longPress = useLongPress(() => {
    const el = pressed.current;
    const entry = entries.find((e) => keyOf(e) === el?.dataset.conversation);
    if (entry) openMenu(entry, el.getBoundingClientRect());
  }, { enabled: isMobile && Boolean(conversationSettings) });
  const rowProps = (entry) => ({
    'data-conversation': keyOf(entry),
    onContextMenu: (e) => {
      e.preventDefault();
      if (!isMobile) openMenu(entry, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
    },
  });
  const listTouchStart = (e) => {
    pressed.current = e.target.closest?.('[data-conversation]') ?? null;
    if (pressed.current) longPress.onTouchStart?.(e);
  };
  const marks = (setting) => (
    <>
      {setting.muted && <FontAwesomeIcon icon={faBellSlash} className="dm-row-mark" title={t('chat.dmList.muted')} aria-label={t('chat.dmList.muted')} />}
      {setting.pinned_at != null && <FontAwesomeIcon icon={faThumbtack} className="dm-row-mark" title={t('chat.dmList.pinned')} aria-label={t('chat.dmList.pinned')} />}
    </>
  );

  const avatar = (id, alt, className = 'dm-user-avatar') => <Avatar userId={id} alt={alt} className={className} />;

  return (
    <div id="dm-sidebar">
      <h4 className="direct-messages-header">
        {t('chat.dmList.title')}
        <button type="button" className="new-group-button" aria-label={t('chat.dmList.newGroup')} title={t('chat.dmList.newGroup')} onClick={() => setNewGroup(true)}>
          <FontAwesomeIcon icon={faUserGroup} />
          <span className="new-group-plus">+</span>
        </button>
      </h4>
      <div className="dm-notes-link-wrap">
        <Link to="/dm/friends" replace={isMobile} onClick={showContent} className={`dm-user dm-friends-link ${friendsActive ? 'active' : ''}`}>
          <span className="dm-notes-icon"><FontAwesomeIcon icon={faUserFriends} /></span>
          <span className="dm-user-name">{t('friends.title')}</span>
          {friends.incoming.length > 0 && (
            <span className="friends-badge" title={t('friends.tabs.pending')}>{friends.incoming.length}</span>
          )}
        </Link>
        <Link to="/dm/notes" replace={isMobile} onClick={showContent} className={`dm-user dm-notes-link ${notesActive ? 'active' : ''}`}>
          <span className="dm-notes-icon"><FontAwesomeIcon icon={faNoteSticky} /></span>
          <span className="dm-user-name">{t('chat.notes.title')}</span>
        </Link>
      </div>
      <div className="dm-user-list-container" {...longPress} onTouchStart={listTouchStart}>
        {entries.map((entry) => {
          const { person, group, botDm, setting } = entry;
          if (botDm) {
            const active = String(botDm.id) === activeBotDmId;
            const name = displayName(botDm.bot_id, botDm.bot?.display_name || botDm.bot?.username);
            return (
              <Link
                key={`b-${botDm.id}`}
                to={`/dm/b/${botDm.id}`}
                replace={isMobile}
                onClick={showContent}
                className={`dm-user dm-bot ${active ? 'active' : ''}${setting.muted ? ' muted' : ''}`}
                {...rowProps(entry)}
              >
                <span className={`userdot${botDm.unread > 0 && !active && !setting.muted ? ' active' : ''}`} />
                <div className="dm-user-container">
                  <span className="dm-user-avatar-wrap">{avatar(botDm.bot_id, name)}</span>
                  <span className="dm-user-names">
                    <span className="dm-user-name">
                      {name} <span className="app-tag" title={t('chat.message.botTitle')}>{t('chat.message.botTag')}</span>
                    </span>
                  </span>
                  {marks(setting)}
                </div>
              </Link>
            );
          }
          if (group) {
            const others = group.members.filter((m) => m.id !== user?.id);
            const active = group.id === activeGroupId;
            return (
              <Link
                key={`g-${group.id}`}
                to={`/dm/g/${group.id}`}
                replace={isMobile}
                onClick={showContent}
                className={`dm-user dm-group ${active ? 'active' : ''}${setting.muted ? ' muted' : ''}`}
                {...rowProps(entry)}
              >
                <span className={`userdot${group.unread > 0 && !active && !setting.muted ? ' active' : ''}`} />
                <div className="dm-user-container">
                  <GroupPicture groupId={group.id} picture={group.picture} className="group-avatar group-picture">
                    <span className="group-avatar">
                      {others.slice(0, 2).map((m) => <span key={m.id}>{avatar(m.id, '', 'group-avatar-img')}</span>)}
                    </span>
                  </GroupPicture>
                  <span className="dm-group-text">
                    <span className="dm-group-name">{groupTitle(group, user)}</span>
                    <span className="dm-group-count">{group.members.length} members</span>
                  </span>
                  {marks(setting)}
                </div>
              </Link>
            );
          }
          const { id } = person;
          const profile = getProfile(id) ?? person;
          const name = nameOf(person);
          const { status, lastOnline } = presenceOf(person);
          return (
            <Link
              key={id}
              to={`/dm/${id}`}
              replace={isMobile}
              onClick={showContent}
              className={`dm-user ${id.toString() === activeId ? 'active' : ''}${setting.muted ? ' muted' : ''}`}
              {...rowProps(entry)}
            >
              <span className={`userdot${unreadFrom.has(String(id)) && String(id) !== activeId && !setting.muted ? ' active' : ''}`} />

              <div className="dm-user-container">
                <span className="dm-user-avatar-wrap status-avatar">
                  {avatar(id, name)}
                  <StatusIcon
                    status={status}
                    title={status === 'offline' ? lastSeenText(lastOnline) ?? statusLabel(status) : undefined}
                  />
                </span>
                <span className="dm-user-names">
                  <span className="dm-user-name">{name}</span>
                  <CustomStatus profile={profile} className="dm-user-custom-status" />
                </span>
                {marks(setting)}
              </div>
            </Link>
          );
        })}
      </div>
      {newGroup && <NewGroupDialog user={user} users={users.filter((u) => friends.friends.has(Number(u.id)))} onCreated={groupList?.upsert} onClose={() => setNewGroup(false)} />}
      {menu && (
        <DmMenu
          person={menu.person}
          group={menu.group}
          botDm={menu.botDm}
          title={menu.group ? groupTitle(menu.group, user) : menu.botDm ? displayName(menu.botDm.bot_id) : nameOf(menu.person)}
          unread={menu.group ? menu.group.unread > 0 : menu.botDm ? menu.botDm.unread > 0 : unreadFrom.has(String(menu.person.id))}
          anchor={menu.anchor}
          sheet={isMobile}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
