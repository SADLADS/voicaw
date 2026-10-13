import React, { useCallback, useEffect, useState } from 'react';
import UserProfile from './UserProfile';
import { onOpenUserProfile } from '../utils/userProfile';

// Draws the full profile opened from anywhere (utils/userProfile.js openUserProfile), one at a
// time: opening another (a mutual friend) replaces it. In Layout, for the logged-in `user`.
export default function UserProfileHost({ user }) {
  const [userId, setUserId] = useState(null);
  useEffect(() => onOpenUserProfile((id) => setUserId(id)), []);
  const close = useCallback(() => setUserId(null), []);
  if (userId == null) return null;
  return <UserProfile userId={userId} me={user.id} onClose={close} onOpenProfile={setUserId} />;
}
