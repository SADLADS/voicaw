import React from 'react';
import { Link, useParams } from 'react-router-dom';

export default function DmSidebar({ users }) {
  const { id: activeId } = useParams();

  return (
    <div id="dm-sidebar">
      <h5 class="direct-messages-header">Direct Messages</h5>
      {users.map(({ id, username }) => (
        <Link
          key={id}
          to={`/dm/${id}`}
          className={`dm-user ${id.toString() === activeId ? 'active' : ''}`}
        >
          {username}
        </Link>
      ))}
    </div>
  );
}
