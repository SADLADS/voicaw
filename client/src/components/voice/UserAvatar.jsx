import React, { useContext, useState } from 'react';
import defaultpfp from '../../assets/images/default.png';
import { ConfigContext } from '../../contexts';

// A user's profile picture (the default one if they have none), round. `speaking` rings it.
export default function UserAvatar({ userId, className = '', speaking = false }) {
  const { s3Endpoint } = useContext(ConfigContext);
  const [failed, setFailed] = useState(false);
  const src = failed || !s3Endpoint ? defaultpfp : `${s3Endpoint}/profile-pics/${userId}`;
  return (
    <img
      src={src}
      alt=""
      className={`user-avatar${speaking ? ' speaking' : ''} ${className}`}
      onError={() => setFailed(true)}
    />
  );
}
