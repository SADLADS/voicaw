import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faUserGroup } from '@fortawesome/free-solid-svg-icons';
import { scrollToRight } from '../utils/scrollToRight';
import { usePresence } from '../hooks/usePresence';
import { lastSeenText, statusLabel } from '../utils/presence';
import { groupTitle } from '../utils/groupDisplay';
import StatusIcon from './StatusIcon';
import NewGroupDialog from './group/NewGroupDialog';
import { getProfile, nameOf, useProfiles } from '../utils/profiles';
import Avatar from './Avatar';

// The conversation list: people and group DMs, most recent first. `unreadDms`
// ([{ from_user_id, count }], from Layout) and each group's `unread` mark conversations with
// unread messages, except the one being viewed. The header's button makes a new group.
export default function DmSidebar({ user, users, groups = [], unreadDms = [] }) {
  useProfiles();
  const { id: activeId, groupId: activeGroupId } = useParams();
  const presenceOf = usePresence();
  const [newGroup, setNewGroup] = useState(false);
  const unreadFrom = new Set(unreadDms.map((u) => String(u.from_user_id)));

  // People keep the server's order among themselves (latest DM first); groups go in by their
  // latest message.
  const entries = [];
  const byTime = [...groups].sort((a, b) => b.last_timestamp - a.last_timestamp);
  let g = 0;
  for (const person of users) {
    while (g < byTime.length && byTime[g].last_timestamp >= (person.last_timestamp ?? 0)) entries.push({ group: byTime[g++] });
    entries.push({ person });
  }
  while (g < byTime.length) entries.push({ group: byTime[g++] });

  const avatar = (id, alt, className = 'dm-user-avatar') => <Avatar userId={id} alt={alt} className={className} />;

  return (
    <div id="dm-sidebar">
      <h4 className="direct-messages-header">
        Direct Messages
        <button type="button" className="new-group-button" aria-label="New group" title="New group" onClick={() => setNewGroup(true)}>
          <FontAwesomeIcon icon={faUserGroup} />
          <span className="new-group-plus">+</span>
        </button>
      </h4>
      <div className="dm-user-list-container">
        {entries.map(({ person, group }) => {
          if (group) {
            const others = group.members.filter((m) => m.id !== user?.id);
            const active = group.id === activeGroupId;
            return (
              <Link
                key={`g-${group.id}`}
                to={`/dm/g/${group.id}`}
                onClick={scrollToRight}
                className={`dm-user dm-group ${active ? 'active' : ''}`}
              >
                <span className={`userdot${group.unread > 0 && !active ? ' active' : ''}`} />
                <div className="dm-user-container">
                  <span className="group-avatar">
                    {others.slice(0, 2).map((m) => <span key={m.id}>{avatar(m.id, '', 'group-avatar-img')}</span>)}
                  </span>
                  <span className="dm-group-text">
                    <span className="dm-group-name">{groupTitle(group, user)}</span>
                    <span className="dm-group-count">{group.members.length} members</span>
                  </span>
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
              onClick={scrollToRight}
              className={`dm-user ${id.toString() === activeId ? 'active' : ''}`}
            >
              <span className={`userdot${unreadFrom.has(String(id)) && String(id) !== activeId ? ' active' : ''}`} />

              <div className="dm-user-container">
                <span className="dm-user-avatar-wrap">
                  {avatar(id, name)}
                  <StatusIcon
                    status={status}
                    title={status === 'offline' ? lastSeenText(lastOnline) ?? statusLabel(status) : undefined}
                  />
                </span>
                <span className="dm-user-names">
                  <span className="dm-user-name">{name}</span>
                  {profile.custom_status && <span className="dm-user-custom-status">{profile.custom_status}</span>}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
      {newGroup && <NewGroupDialog user={user} users={users} onClose={() => setNewGroup(false)} />}
    </div>
  );
}
