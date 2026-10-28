import React, { useState } from 'react';
import defaultpfp from '../assets/images/default.png';
import { avatarUrl, getProfile, useProfiles } from '../utils/profiles';
import { letterAvatar } from '../utils/letterAvatar';

// Someone's profile picture: their current one from the profile store (utils/profiles), or, if
// they have none (or it won't load), their username's first letter on their own colour
// (utils/letterAvatar; deleted accounts and no user keep the plain default). `src` overrides it
// (a preview). Other props (className, alt, onClick...) go on the <img>. It's marked
// `data-user-id`, so right-clicking it offers Copy User ID (PageMenus).
export default function Avatar({ userId, src, alt = '', ...props }) {
  useProfiles();
  const url = src ?? avatarUrl(userId);
  const [failed, setFailed] = useState(null);
  const profile = getProfile(userId);
  const fallback = userId == null || profile?.deleted_at ? defaultpfp : letterAvatar(userId, profile?.username);
  return (
    <img
      data-user-id={userId ?? undefined}
      {...props}
      src={url && failed !== url ? url : fallback}
      alt={alt}
      draggable={false}
      onError={() => setFailed(url)}
    />
  );
}
