import React, { useState, useEffect, useRef, useContext } from 'react';
import { Link, useParams } from 'react-router-dom';
import { onUserStatus } from '../utils/ws-client';
import { scrollToRight } from './Layout';
import defaultpfp from '../assets/images/default.png';
import { ConfigContext } from '../App';

export default function DmSidebar({ users }) {
  const { id: activeId } = useParams();
  const [userList, setUserList] = useState(users);
  const { s3Endpoint } = useContext(ConfigContext);
  
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
              <span className="userdot" id={`user-dot-${id.toString()}`} />

              <div className="dm-user-container">
                <span><img
                  src={imgSrc}
                  alt={username}
                  onError={(e) => {
                    e.currentTarget.onerror = null;
                    e.currentTarget.src = defaultpfp;
                  }}
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    objectFit: 'cover',
                  }}
                /></span><span> {username}</span></div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}