import { useSyncExternalStore } from 'react';

// How loud each person is on this device (like Discord's User Volume and Stream Volume): 0–200%
// of their voice, and separately of their screen share's sound, on top of the output volume
// (audioSettings.js). Per device, `localStorage userVolumes` and `streamVolumes`
// ({ userId: volume }, only those not at 100%), for voice channels and calls alike;
// voiceClient.js applies them as they change.

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

function createVolumeStore(key) {
  function load() {
    try {
      return cleanUserVolumes(JSON.parse(localStorage.getItem(key) ?? 'null'));
    } catch {
      return {};
    }
  }

  let volumes = load();
  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const get = (userId) => volumes[String(userId)] ?? DEFAULT_USER_VOLUME;

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function set(userId, volume) {
    volumes = cleanUserVolumes({ ...volumes, [String(userId)]: volume });
    try {
      localStorage.setItem(key, JSON.stringify(volumes));
    } catch {
      // Not remembered, then.
    }
    notify();
  }

  // Another tab changed them.
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== key) return;
      volumes = load();
      notify();
    });
  }

  return { get, set, onChange, use: (userId) => useSyncExternalStore(onChange, () => get(userId)) };
}

const userVolumes = createVolumeStore('userVolumes');
const streamVolumes = createVolumeStore('streamVolumes');

export const getUserVolume = userVolumes.get;
export const setUserVolume = userVolumes.set;
export const useUserVolume = userVolumes.use;
export const onUserVolumesChange = userVolumes.onChange;

// A screen share's sound (components/voice/StreamView.jsx).
export const getStreamVolume = streamVolumes.get;
export const setStreamVolume = streamVolumes.set;
export const useStreamVolume = streamVolumes.use;
export const onStreamVolumesChange = streamVolumes.onChange;

// What a remote track plays at: nothing while deafened, else the output volume times the
// person's own (`userVolume`: their microphone's, or their stream's for a screen share's
// sound). Above 100% only through Web Audio (`canBoost`): a media element's volume stops at 1.
export function playbackVolume({ selfDeaf, outputVolume, userVolume = DEFAULT_USER_VOLUME, canBoost }) {
  if (selfDeaf) return 0;
  return Math.min(canBoost ? MAX_USER_VOLUME : 1, Math.max(0, outputVolume * userVolume));
}
