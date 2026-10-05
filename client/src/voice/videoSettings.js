import { useSyncExternalStore } from 'react';
import { t } from '../i18n';

// Camera settings on this device (Settings → Voice & video, localStorage `videoSettings`):
// which camera. Like the microphone's (audioSettings.js), a device id only means something on
// this device, and one that's gone (unplugged) falls back to the system's default.

const KEY = 'videoSettings';

export const DEFAULT_VIDEO_SETTINGS = {
  cameraDeviceId: '', // '': the system's default (a phone's front camera)
};

export function cleanVideoSettings(raw) {
  const saved = raw && typeof raw === 'object' ? raw : {};
  const id = typeof saved.cameraDeviceId === 'string' && saved.cameraDeviceId.length <= 512 ? saved.cameraDeviceId : '';
  return { cameraDeviceId: id };
}

function load() {
  try {
    return cleanVideoSettings(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return DEFAULT_VIDEO_SETTINGS;
  }
}

let settings = load();
const listeners = new Set();

export const getVideoSettings = () => settings;

export function onVideoSettingsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useVideoSettings = () => useSyncExternalStore(onVideoSettingsChange, getVideoSettings);

export function setVideoSettings(changes) {
  const previous = settings;
  settings = cleanVideoSettings({ ...settings, ...changes });
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not remembered, then.
  }
  for (const listener of listeners) listener(settings, previous);
}

// The camera as LiveKit takes it: 720p at 30 fps (LiveKit sends it in three sizes, see
// CAMERA_PUBLISH), the chosen camera as `ideal` so a missing one falls back to another, the
// front one on phones.
export function cameraOptions(s = settings) {
  return {
    ...(s.cameraDeviceId ? { deviceId: { ideal: s.cameraDeviceId } } : { facingMode: 'user' }),
    resolution: { width: 1280, height: 720, frameRate: 30 },
  };
}

// Publishing it: simulcast (LiveKit's default layers for 720p, 180p and 360p besides), so
// small tiles get a small copy.
export const CAMERA_PUBLISH = { simulcast: true };

// The cameras, as { cameras: [{ id, label }], labelled }. `labelled` is false until the page
// may use the camera: browsers hide names (and often ids) until then, listing placeholders
// without an id, which are left out.
export async function listCameras() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return { cameras: [], labelled: true };
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const cameras = devices
    .filter((d) => d.deviceId)
    .map((d, i) => ({ id: d.deviceId, label: d.label || t('settings.voice.cameraNumbered', { number: i + 1 }) }));
  return { cameras, labelled: devices.length === 0 || devices.some((d) => d.label) };
}
