import { useSyncExternalStore } from 'react';

// How loud each person is on this device (like Discord's User Volume): 0–200% of their voice,
// on top of the output volume (audioSettings.js). Per device, `localStorage userVolumes`
// ({ userId: volume }, only those not at 100%), for voice channels and calls alike;
// voiceClient.js applies it to their microphone (not their screen share's sound) as it changes.

const KEY = 'userVolumes';
export const MAX_USER_VOLUME = 2;
export const DEFAULT_USER_VOLUME = 1;

export function cleanUserVolumes(raw) {
  const volumes = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return volumes;
  for (const [id, volume] of Object.entries(raw)) {
    if (!/^\d{1,20}$/.test(id) || !Number.isFinite(volume) || volume === DEFAULT_USER_VOLUME) continue;
    volumes[id] = Math.min(MAX_USER_VOLUME, Math.max(0, volume));
  }
  return volumes;
}

function load() {
  try {
    return cleanUserVolumes(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return {};
  }
}

let volumes = load();
const listeners = new Set();

export const getUserVolume = (userId) => volumes[String(userId)] ?? DEFAULT_USER_VOLUME;

export function onUserVolumesChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useUserVolume = (userId) =>
  useSyncExternalStore(onUserVolumesChange, () => getUserVolume(userId));

export function setUserVolume(userId, volume) {
  volumes = cleanUserVolumes({ ...volumes, [String(userId)]: volume });
  try {
    localStorage.setItem(KEY, JSON.stringify(volumes));
  } catch {
    // Not remembered, then.
  }
  for (const listener of listeners) listener();
}

// Another tab changed them.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    volumes = load();
    for (const listener of listeners) listener();
  });
}

// What a remote track plays at: nothing while deafened, else the output volume times the
// person's own (`userVolume`; 1 for a screen share's sound). Above 100% only through Web Audio
// (`canBoost`): a media element's volume stops at 1.
export function playbackVolume({ selfDeaf, outputVolume, userVolume = DEFAULT_USER_VOLUME, canBoost }) {
  if (selfDeaf) return 0;
  return Math.min(canBoost ? MAX_USER_VOLUME : 1, Math.max(0, outputVolume * userVolume));
}
