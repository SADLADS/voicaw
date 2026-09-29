// Call sounds, made with Web Audio (no audio files): the ring of an incoming call, and the
// ringback the caller hears while it rings. One plays at a time. Browsers may refuse to play
// before the page has had a click; then it's silent (the incoming call still shows).

const PATTERNS = {
  // Two rising notes, twice, every 3 s.
  incoming: { every: 3000, notes: [[0, 660, 0.15], [0.18, 880, 0.15], [0.45, 660, 0.15], [0.63, 880, 0.2]], volume: 0.18 },
  // A soft 440+480 Hz tone for 1.5 s, every 4 s (the usual ringback).
  ringback: { every: 4000, notes: [[0, 440, 1.5], [0, 480, 1.5]], volume: 0.05 },
};

let context = null;
let timer = null;

function playOnce({ notes, volume }) {
  const start = context.currentTime + 0.02;
  for (const [at, frequency, length] of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start + at);
    gain.gain.linearRampToValueAtTime(volume, start + at + 0.02);
    gain.gain.setValueAtTime(volume, start + at + length - 0.05);
    gain.gain.linearRampToValueAtTime(0, start + at + length);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + at);
    oscillator.stop(start + at + length);
  }
}

// 'incoming' | 'ringback'
export function startTone(kind) {
  stopTone();
  const pattern = PATTERNS[kind];
  try {
    context ??= new AudioContext();
    context.resume().catch(() => {});
    playOnce(pattern);
    timer = setInterval(() => playOnce(pattern), pattern.every);
  } catch (err) {
    console.warn('Could not play the call sound', err);
  }
}

export function stopTone() {
  clearInterval(timer);
  timer = null;
  // Cut off anything still sounding.
  if (context) {
    const old = context;
    context = null;
    old.close().catch(() => {});
  }
}
