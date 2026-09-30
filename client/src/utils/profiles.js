import { useSyncExternalStore } from 'react';

// Everyone's profile (display name, custom status, bio; see server/profiles.js), by user id,
// so any name drawn anywhere is the person's current display name. Fed by whatever the API
// returns with users in it (the users list, guild members, group details, your own profile:
// `mergeProfiles`) and by `user_profile` events when someone edits theirs (ws-client).
// Components that draw names call useProfiles() so they redraw when one changes.

const profiles = new Map(); // user id (string) -> { id, username, display_name, custom_status, bio }
const listeners = new Set();
let version = 0;

const FIELDS = ['username', 'display_name', 'custom_status', 'bio'];

// Takes users ([{ id, username, display_name?, ... }]); fields they don't have are kept.
export function mergeProfiles(users) {
  let changed = false;
  for (const user of users ?? []) {
    if (user?.id == null) continue;
    const key = String(user.id);
    const before = profiles.get(key) ?? { id: user.id };
    const next = { ...before };
    for (const field of FIELDS) if (field in user) next[field] = user[field];
    if (FIELDS.some((field) => next[field] !== before[field])) {
      profiles.set(key, next);
      changed = true;
    }
  }
  if (changed) {
    version += 1;
    listeners.forEach((listener) => listener());
  }
}

export function getProfile(id) {
  return id == null ? null : profiles.get(String(id)) ?? null;
}

// The name to show for user `id`: their display name, else their username, else `fallback`
// (e.g. the username a message came with).
export function displayName(id, fallback = '') {
  const profile = getProfile(id);
  return profile?.display_name || profile?.username || fallback || '';
}

// The same for a user object ({ id, username, display_name? }); the store's current profile
// wins over what the object came with (it may be older).
export function nameOf(user) {
  if (!user) return '';
  return displayName(user.id, user.display_name || user.username);
}

// Forgets everyone (logging out).
export function clearProfiles() {
  profiles.clear();
  version += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Redraws the component whenever a profile changes (returns a change counter).
export function useProfiles() {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

// Limits, as the server has them.
export const PROFILE_LIMITS = { display_name: 32, custom_status: 128, bio: 190 };
