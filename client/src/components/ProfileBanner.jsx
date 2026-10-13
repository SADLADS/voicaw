import React, { useState } from 'react';
import { bannerUrl, getProfile, useProfiles } from '../utils/profiles';
import { colorToHex } from '../utils/permissions';

// The banner across the top of someone's profile card and profile: their banner picture
// (server/avatars.js), else their banner colour, else the app's soft accent. `src` stands in for
// the picture (a preview while editing; null for none), `color` for the colour (0xRRGGBB, null
// for the default), each only when given.
export default function ProfileBanner({ userId, src, color, className = '', children }) {
  useProfiles();
  const profile = getProfile(userId);
  const picture = src !== undefined ? src : bannerUrl(userId);
  const colour = color !== undefined ? color : profile?.banner_color;
  const [failed, setFailed] = useState(null);
  return (
    <div
      className={`profile-banner ${className}`}
      style={colour != null ? { backgroundColor: colorToHex(colour) } : undefined}
    >
      {picture && failed !== picture && <img src={picture} alt="" draggable={false} onError={() => setFailed(picture)} />}
      {children}
    </div>
  );
}
