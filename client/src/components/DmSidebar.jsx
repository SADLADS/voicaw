import React, { useState, useEffect, useContext } from 'react';
import { Link, useParams } from 'react-router-dom';
import { onUserStatus } from '../utils/ws-client';
import { scrollToRight } from '../utils/scrollToRight';
import defaultpfp from '../assets/images/default.png';
import { ConfigContext } from '../contexts';

// The conversation list. `unreadDms` ([{ from_user_id, count }], from Layout) marks
// conversations with unread messages, except the one being viewed.
export default function DmSidebar({ users, unreadDms = [] }) {
  const { id: activeId } = useParams();
  const [userList, setUserList] = useState(users);
  const { s3Endpoint } = useContext(ConfigContext);
  const unreadFrom = new Set(unreadDms.map((u) => String(u.from_user_id)));

  useEffect(() => {
    // Keep initial users from props
    setUserList(users);
  }, [users]);

  useEffect(() => {
    const unsubscribe = onUserStatus(({ userId, status }) => {
      setUserList((prev) =>
        prev.map((u) =>
          u.id.toString() === userId.toString()
            ? { ...u, online: status === 'online' }
            : u
        )
      );
    });
    return unsubscribe; // cleanup listener
  }, []);

  return (
    <div id="dm-sidebar">
      <h4 className="direct-messages-header">Direct Messages</h4>
      <div className="dm-user-list-container">
        {userList.map(({ id, username, online }) => {
          const imgSrc = `${s3Endpoint}/profile-pics/${id}`;
          return (
            <Link
              key={id}
              to={`/dm/${id}`}
              onClick={scrollToRight}
              className={`dm-user ${id.toString() === activeId ? 'active' : ''}`}
            >
              <span className={`online-dot ${online ? 'online' : 'offline'}`} />
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