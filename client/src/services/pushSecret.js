import { getSetting, setSetting } from './settingsStore';

// A random secret this device makes for its web push subscription: the server keeps its hash,
// and the service worker shows it to swap in a replacement subscription without a login
// (server routes/push.js /update-subscription; the old endpoint alone isn't proof, since the
// next person to log in on this browser gets the same one). In settingsStore, which the
// service worker can read; forgotten at logout, so the next account here gets a new one.
const NAME = 'pushUpdateSecret';

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The secret, made the first time it's asked for; null if it can't be stored (no IndexedDB),
// as the service worker couldn't show it then.
export async function pushUpdateSecret() {
  const saved = await getSetting(NAME);
  if (typeof saved === 'string' && saved) return saved;
  const secret = randomSecret();
  try {
    await setSetting(NAME, secret);
  } catch {
    return null;
  }
  return secret;
}

// Only reads it (the service worker): null if this device never made one.
export async function savedPushUpdateSecret() {
  const saved = await getSetting(NAME);
  return typeof saved === 'string' && saved ? saved : null;
}

export async function forgetPushUpdateSecret() {
  await setSetting(NAME, null);
}
