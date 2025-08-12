import React, { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { onUserStatus } from '../utils/ws-client';

export default function DmSidebar({ users }) {
  const { id: activeId } = useParams();
  const [userList, setUserList] = useState(users);

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
        {userList.map(({ id, username, online }) => (
          <Link
            key={id}
            to={`/dm/${id}`}
            className={`dm-user ${id.toString() === activeId ? 'active' : ''}`}
          >
            <span className={`online-dot ${online ? 'online' : 'offline'}`} />
            <span
              className="userdot"
              id={`user-dot-${id.toString()}`}
            />
            <div className="dm-user-container">
              {username}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
