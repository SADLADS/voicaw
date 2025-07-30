import React from 'react';
import { Link, useParams } from 'react-router-dom';

export default function DmSidebar({ users }) {
  const { id: activeId } = useParams();

  return (
    <div id="dm-sidebar">
      <h4 className="direct-messages-header">Direct Messages</h4>
      {users.map(({ id, username }) => (
        <Link
          key={id}
          to={`/dm/${id}`}
          className={`dm-user ${id.toString() === activeId ? 'active' : ''}`}
        >
          <span
            className="userdot"
            id={`user-dot-${id.toString()}`}
          />
          <div className={'dm-user-container'}>
            {username}
          </div>
        </Link>
      ))}
    </div>
  );
}
