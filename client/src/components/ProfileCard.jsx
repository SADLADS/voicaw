import React from 'react';
import Avatar from './Avatar';
import StatusIcon from './StatusIcon';
import { usePresence } from '../hooks/usePresence';
import { getProfile, useProfiles } from '../utils/profiles';
import { lastSeenText, statusLabel } from '../utils/presence';
import { t } from '../i18n';

// The top of someone's profile: picture (with online status), display name (in `color`, e.g. a
// guild role's), @username, their status or last seen, custom status and bio. `user` needs
// { id, username }; the rest comes from the profile store (utils/profiles). `children` go
// under it (the guild member card's roles and actions). For a preview (Edit Profile): `draft` ({ display_name, custom_status, bio }) replaces the
// saved profile and `avatarSrc` the picture.
export default function ProfileCard({ user, color, children, draft, avatarSrc }) {
  useProfiles();
  const presenceOf = usePresence();
  const profile = { ...user, ...getProfile(user.id), ...draft };
  const presence = presenceOf(profile);
  const name = profile.display_name || profile.username;

  return (
    <div className="profile-card" data-user-id={draft ? undefined : user.id}>
      <div className="profile-card-top">
        <span className="profile-card-avatar status-avatar">
          <Avatar userId={user.id} src={avatarSrc} />
          <StatusIcon status={presence.status} />
        </span>
        <div className="profile-card-names">
          <div className="profile-card-name" style={color ? { color } : undefined}>{name}</div>
          {profile.display_name && <div className="profile-card-username">{profile.username}</div>}
          <div className={`profile-card-presence ${presence.status}`}>
            {presence.status === 'offline' ? lastSeenText(presence.lastOnline) ?? statusLabel('offline') : statusLabel(presence.status)}
          </div>
        </div>
      </div>
      {profile.custom_status && <div className="profile-card-custom-status">{profile.custom_status}</div>}
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
