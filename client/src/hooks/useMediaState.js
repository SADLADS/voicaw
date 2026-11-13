import { useLayoutEffect, useState } from 'react';
import { bufferedSpans } from '../utils/videoPlayer';

const EVENTS = [
  'play', 'pause', 'ended', 'waiting', 'playing', 'canplay', 'timeupdate', 'seeked', 'seeking',
  'progress', 'loadedmetadata', 'durationchange', 'emptied', 'volumechange', 'error',
];

// HAVE_FUTURE_DATA: enough to carry on playing.
const HAVE_FUTURE_DATA = 3;

function snapshot(el) {
  if (!el) {
    return { paused: true, ended: false, waiting: false, failed: false, time: 0, duration: null, natural: null, spans: [], volume: 1, muted: false };
  }
  const duration = Number.isFinite(el.duration) ? el.duration : null;
  return {
    paused: el.paused,
    ended: el.ended,
    waiting: !el.paused && !el.error && el.readyState < HAVE_FUTURE_DATA,
    failed: Boolean(el.error),
    time: el.currentTime || 0,
    duration,
    natural: el.videoWidth && el.videoHeight ? { width: el.videoWidth, height: el.videoHeight } : null,
    spans: bufferedSpans(el.buffered, el.duration),
    volume: el.volume,
    muted: el.muted,
  };
}

// What a <video> element is doing, from its own events: so whichever player shows it (its
// message, the corner, a window) reads the same element.
export function useMediaState(element) {
  const [state, setState] = useState(() => snapshot(element));
  useLayoutEffect(() => {
    const update = () => setState(snapshot(element));
    update();
    if (!element) return undefined;
    for (const name of EVENTS) element.addEventListener(name, update);
    return () => {
      for (const name of EVENTS) element.removeEventListener(name, update);
    };
  }, [element]);
  return state;
}
