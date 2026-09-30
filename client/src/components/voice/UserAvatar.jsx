import React from 'react';
import Avatar from '../Avatar';

// A user's profile picture (the default one if they have none), round. `speaking` rings it.
export default function UserAvatar({ userId, className = '', speaking = false }) {
  return <Avatar userId={userId} className={`user-avatar${speaking ? ' speaking' : ''} ${className}`} />;
}
