import { useSyncExternalStore } from 'react';

// Everyone's profile (display name, custom status, bio, picture; see server/profiles.js), by user id,
// so any name drawn anywhere is the person's current display name. Fed by whatever the API
// returns with users in it (the users list, guild members, group details, your own profile:
// `mergeProfiles`) and by `user_profile` events when someone edits theirs (ws-client).
// Components that draw names call useProfiles() so they redraw when one changes.

const profiles = new Map(); // user id (string) -> { id, username, display_name, custom_status, custom_status_emoji, bio }
const listeners = new Set();
let version = 0;

// `deleted_at`: set once the account is deleted (server/accounts.js; shown as "Deleted User").
// `bot`: a bot (server/bots.js), only ever met in guilds.
const FIELDS = ['username', 'display_name', 'custom_status', 'custom_status_emoji', 'bio', 'avatar', 'deleted_at', 'bot'];
let avatarBase = '';

// Called once the server config (with the object store's address) has loaded, which may be
// after pictures were drawn (the config is asked again until it comes, see App): those redraw.
export function setAvatarBase(s3Endpoint) {
  const base = s3Endpoint ? `${s3Endpoint}/profile-pics/` : '';
  if (base === avatarBase) return;
  avatarBase = base;
  version += 1;
  listeners.forEach((listener) => listener());
}

// User `id`'s profile picture URL (server/avatars.js: a new name for every picture, so it's
// never stale), or null when they have none (draw the default one).
export function avatarUrl(id) {
  const avatar = getProfile(id)?.avatar;
  return avatar && avatarBase ? `${avatarBase}${id}/${avatar}.webp` : null;
}

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

// Whether user `id` is a bot (server/bots.js): no DMs or calls with it.
export function isBot(id) {
  return Boolean(getProfile(id)?.bot);
}

// Whether `user`'s account has been deleted (its chats can be read, not answered).
export function isDeleted(user) {
  if (!user) return false;
  return Boolean(getProfile(user.id)?.deleted_at ?? user.deleted_at);
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
