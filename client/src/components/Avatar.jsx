import React, { useState } from 'react';
import defaultpfp from '../assets/images/default.png';
import { avatarUrl, useProfiles } from '../utils/profiles';

// Someone's profile picture: their current one from the profile store (utils/profiles), or the
// default one if they have none (or it won't load). `src` overrides it (a preview). Other props
// (className, alt, onClick...) go on the <img>.
export default function Avatar({ userId, src, alt = '', ...props }) {
  useProfiles();
  const url = src ?? avatarUrl(userId);
  const [failed, setFailed] = useState(null);
  return (
    <img
      {...props}
      src={url && failed !== url ? url : defaultpfp}
      alt={alt}
      draggable={false}
      onError={() => setFailed(url)}
    />
  );
}
