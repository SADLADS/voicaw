import { useSyncExternalStore } from 'react';

// Screen share quality on this device (Settings → Voice & video, the Go Live dialog and the
// desktop app's picker; localStorage `streamSettings`), as Discord's: a resolution (720p,
// 1080p or the screen's own, "source") and a frame rate. A global admin can cap both
// (Settings → Admin, `streamMaxResolution` / `streamMaxFramerate`, sent with the voice token):
// a choice above the cap goes out at the cap.

const KEY = 'streamSettings';

export const RESOLUTIONS = ['720', '1080', 'source']; // lowest first
export const FRAME_RATES = [15, 30, 60];

// LiveKit's own default (1080p at 15 fps), so nothing changes for anyone who never picks.
export const DEFAULT_STREAM_SETTINGS = { resolution: '1080', frameRate: 15 };

const HEIGHTS = { 720: 720, 1080: 1080 };

// Bits per second the sharer's browser may send, by resolution and frame rate (the full-size
// copy; LiveKit adds a half-size one at a quarter of it, see docs/voice-and-calls.md). Every
// viewer downloads this from the server, so it's also what each viewer costs the server.
const BITRATES = {
  720: { 15: 1_500_000, 30: 2_500_000, 60: 4_000_000 },
  1080: { 15: 2_500_000, 30: 4_500_000, 60: 7_000_000 },
  source: { 15: 4_000_000, 30: 7_000_000, 60: 10_000_000 },
};

export function cleanStreamSettings(raw) {
  const saved = raw && typeof raw === 'object' ? raw : {};
  return {
    resolution: RESOLUTIONS.includes(saved.resolution) ? saved.resolution : DEFAULT_STREAM_SETTINGS.resolution,
    frameRate: FRAME_RATES.includes(saved.frameRate) ? saved.frameRate : DEFAULT_STREAM_SETTINGS.frameRate,
  };
}

// The server's cap, { resolution, frameRate } (either missing: no cap), cleaned.
export function cleanStreamLimit(raw) {
  const limit = raw && typeof raw === 'object' ? raw : {};
  return {
    resolution: RESOLUTIONS.includes(limit.resolution) ? limit.resolution : 'source',
    frameRate: FRAME_RATES.includes(limit.frameRate) ? limit.frameRate : 60,
  };
}

// Whether a resolution or frame rate is above the cap.
export const resolutionAllowed = (resolution, limit) =>
  RESOLUTIONS.indexOf(resolution) <= RESOLUTIONS.indexOf(cleanStreamLimit(limit).resolution);
export const frameRateAllowed = (frameRate, limit) => frameRate <= cleanStreamLimit(limit).frameRate;

// `settings` brought down to `limit`.
export function clampStream(settings, limit) {
  const s = cleanStreamSettings(settings);
  const cap = cleanStreamLimit(limit);
  return {
    resolution: resolutionAllowed(s.resolution, cap) ? s.resolution : cap.resolution,
    frameRate: Math.min(s.frameRate, cap.frameRate),
  };
}

// What LiveKit's setScreenShareEnabled takes for `settings` under `limit`: `capture` (the
// browser's capture: at most that height, keeping the screen's shape, never enlarged; a
// content hint) and `publish` (the encoder's limits). 15 fps is for reading (text stays sharp
// and the frame rate drops first when the connection is short), 30 and 60 for motion (games,
// videos: the resolution drops first).
export function screenShareOptions(settings, limit) {
  const { resolution, frameRate } = clampStream(settings, limit);
  const height = HEIGHTS[resolution];
  const video = {
    frameRate: { ideal: frameRate, max: frameRate },
    ...(height ? { width: { max: Math.round((height * 16) / 9) }, height: { max: height } } : {}),
  };
  return {
    // LiveKit puts its own 1080p in when `resolution` is missing, over `video`; 0x0 is its
    // "no size", which leaves ours.
    capture: { resolution: { width: 0, height: 0 }, video, contentHint: frameRate > 15 ? 'motion' : 'detail' },
    publish: { screenShareEncoding: { maxBitrate: BITRATES[resolution][frameRate], maxFramerate: frameRate } },
  };
}

function load() {
  try {
    return cleanStreamSettings(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return DEFAULT_STREAM_SETTINGS;
  }
}

let settings = load();
const listeners = new Set();

export const getStreamSettings = () => settings;

export function onStreamSettingsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useStreamSettings = () => useSyncExternalStore(onStreamSettingsChange, getStreamSettings);

export function setStreamSettings(changes) {
  settings = cleanStreamSettings({ ...settings, ...changes });
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not remembered, then.
  }
  for (const listener of listeners) listener(settings);
}
