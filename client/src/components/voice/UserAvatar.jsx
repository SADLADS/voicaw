import React from 'react';
import Avatar from '../Avatar';

// A user's profile picture (the default one if they have none), round. `speaking` rings it.
// Other props (onClick...) go on the picture: in voice, useProfileCard's `pictureProps`.
export default function UserAvatar({ userId, className = '', speaking = false, ...props }) {
  return <Avatar userId={userId} className={`user-avatar${speaking ? ' speaking' : ''} ${className}`} {...props} />;
}
