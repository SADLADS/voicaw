import React from 'react';
import Avatar from './Avatar';
import StatusIcon from './StatusIcon';
import CustomStatus from './CustomStatus';
import Activities from './Activities';
import ProfileBanner from './ProfileBanner';
import { usePresence } from '../hooks/usePresence';
import { getProfile, useProfiles } from '../utils/profiles';
import { lastSeenText, statusLabel } from '../utils/presence';
import { openUserProfile } from '../utils/userProfile';
import { t } from '../i18n';

// The top of someone's profile: their banner (ProfileBanner), picture (with online status),
// display name (in `color`, e.g. a guild role's), @username, their status or last seen, custom
// status (with its emoji), what they're playing (Activities) and bio. `user` needs { id,
// username }; the rest comes from the profile store (utils/profiles). The picture and the names
// open their full profile (UserProfile). `children` go under it (the guild member card's roles
// and Apps). For a preview (Edit Profile): `draft` ({ display_name, custom_status,
// custom_status_emoji, bio, banner_color }) replaces the saved profile, `avatarSrc` the picture
// and `bannerSrc` the banner's (null for none); nothing opens.
const AVATAR_CLASS = 'profile-card-avatar status-avatar';
const NAME_CLASS = 'profile-card-name';
const USERNAME_CLASS = 'profile-card-username';

export default function ProfileCard({ user, color, children, draft, avatarSrc, bannerSrc }) {
  useProfiles();
  const presenceOf = usePresence();
  const profile = { ...user, ...getProfile(user.id), ...draft };
  const presence = presenceOf(profile);
  const name = profile.display_name || profile.username;
  // The picture and names open the full profile (not in a preview).
  const Opens = draft ? 'div' : 'button';
  const opens = (className, label) => (draft ? { className } : {
    type: 'button',
    className: `${className} profile-card-open`,
    'aria-label': label,
    onClick: () => openUserProfile(user.id),
  });

  return (
    <div className="profile-card" data-user-id={draft ? undefined : user.id}>
      <ProfileBanner userId={user.id} src={bannerSrc} color={draft && 'banner_color' in draft ? draft.banner_color : undefined} className="profile-card-banner" />
      <div className="profile-card-top">
        <Opens {...opens(AVATAR_CLASS, t('app.profile.open'))}>
          <Avatar userId={user.id} src={avatarSrc} />
          <StatusIcon status={presence.status} />
        </Opens>
        <div className="profile-card-names">
          <Opens {...opens(NAME_CLASS)} style={color ? { color } : undefined}>{name}</Opens>
          {profile.display_name && <Opens {...opens(USERNAME_CLASS)}>{profile.username}</Opens>}
          <div className={`profile-card-presence ${presence.status}`}>
            {presence.status === 'offline' ? lastSeenText(presence.lastOnline) ?? statusLabel('offline') : statusLabel(presence.status)}
          </div>
        </div>
      </div>
      <CustomStatus profile={profile} className="profile-card-custom-status" />
      {!draft && <Activities userId={user.id} />}
      {profile.bio && (
        <div className="profile-card-section">
          <div className="member-card-label">{t('app.profile.aboutMe')}</div>
          <p className="profile-card-bio">{profile.bio}</p>
        </div>
      )}
      {children}
    </div>
  );
}
