import React, { useContext } from 'react';
import { Link, useParams } from 'react-router-dom';
import { scrollToRight } from '../utils/scrollToRight';
import { usePresence } from '../hooks/usePresence';
import { lastSeenText, statusLabel } from '../utils/presence';
import StatusIcon from './StatusIcon';
import defaultpfp from '../assets/images/default.png';
import { ConfigContext } from '../contexts';

// The conversation list. `unreadDms` ([{ from_user_id, count }], from Layout) marks
// conversations with unread messages, except the one being viewed.
export default function DmSidebar({ users, unreadDms = [] }) {
  const { id: activeId } = useParams();
  const { s3Endpoint } = useContext(ConfigContext);
  const presenceOf = usePresence();
  const unreadFrom = new Set(unreadDms.map((u) => String(u.from_user_id)));

  return (
    <div id="dm-sidebar">
      <h4 className="direct-messages-header">Direct Messages</h4>
      <div className="dm-user-list-container">
        {users.map((user) => {
          const { id, username } = user;
          const { status, lastOnline } = presenceOf(user);
          const imgSrc = `${s3Endpoint}/profile-pics/${id}`;
          return (
            <Link
              key={id}
              to={`/dm/${id}`}
              onClick={scrollToRight}
              className={`dm-user ${id.toString() === activeId ? 'active' : ''}`}
            >
              <StatusIcon
                className="online-dot"
                status={status}
                title={status === 'offline' ? lastSeenText(lastOnline) ?? statusLabel(status) : undefined}
              />
              <span className={`userdot${unreadFrom.has(String(id)) && String(id) !== activeId ? ' active' : ''}`} />

              <div className="dm-user-container">
                <span><img
                  src={imgSrc}
                  alt={username}
                  onError={(e) => {
                    e.currentTarget.onerror = null;
                    e.currentTarget.src = defaultpfp;
                  }}
                  className="dm-user-avatar"
                /></span><span> {username}</span></div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}