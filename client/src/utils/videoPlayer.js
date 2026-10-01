// Small pieces of the video player (components/VideoPlayer.jsx).

// 75 -> "1:15", 3725 -> "1:02:05".
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// A media element's buffered ranges as [start, end] fractions of `duration`.
export function bufferedSpans(buffered, duration) {
  if (!buffered || !(duration > 0)) return [];
  const spans = [];
  for (let i = 0; i < buffered.length; i++) {
    spans.push([buffered.start(i) / duration, Math.min(1, buffered.end(i) / duration)]);
  }
  return spans;
}

const PREFS_KEY = 'videoPrefs';

// Volume and mute, per device, shared by every video.
export function readVideoPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY));
    const volume = Number(prefs?.volume);
    return {
      volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1,
      muted: prefs?.muted === true,
    };
  } catch {
    return { volume: 1, muted: false };
  }
}

export function saveVideoPrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or storage blocked: just not remembered.
  }
}

// Only one video plays at a time: starting one pauses the one before.
let playing = null;
export function claimPlayback(video) {
  if (playing && playing !== video && !playing.paused) playing.pause();
  playing = video;
}
