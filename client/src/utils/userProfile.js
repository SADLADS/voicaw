// Opening someone's full profile (components/UserProfile.jsx) from anywhere: their picture or
// names on a profile card (ProfileCard), a mutual friend in another profile. UserProfileHost (in
// Layout) draws it; without one (tests, logged out) nothing happens.

let opener = null;

export function onOpenUserProfile(listener) {
  opener = listener;
  return () => {
    if (opener === listener) opener = null;
  };
}

export function openUserProfile(userId) {
  opener?.(userId);
}
