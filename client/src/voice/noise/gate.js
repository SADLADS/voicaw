// The microphone's gate (Settings → Voice & video, Input sensitivity), like Discord's: silence
// between words, so typing, clicks and breathing while you aren't talking aren't sent.
// Automatic opens on RNNoise's speech probability (it tells a voice from a key press far
// better than loudness does); manual opens on loudness, above a threshold in dB
// (ALWAYS_OPEN_DB: never closes). Runs in the voice worklet, on 10 ms frames.
//
// To open automatically it needs two frames of speech in a row: a key click can score one
// frame nearly as high as a voice, never two. It looks two frames ahead, so it's open from
// the frame before the first one of speech (words aren't clipped), holds on for a moment
// after the last, and fades instead of switching (no clicks of its own).

export const ALWAYS_OPEN_DB = -100;
const OPEN_SPEECH = 0.6; // speech probability that opens it (two frames running)
const KEEP_SPEECH = 0.3; // that keeps it open
const HOLD_MS = 300;
const ATTACK_MS = 5;
const RELEASE_MS = 80;
export const LOOKAHEAD_FRAMES = 2;

export function createGate({ frameSize, sampleRate }) {
  let options = { auto: true, thresholdDb: -50 };
  const holdFrames = Math.round((HOLD_MS / 1000) * sampleRate / frameSize);
  const attackStep = 1 / ((ATTACK_MS / 1000) * sampleRate);
  const releaseStep = 1 / ((RELEASE_MS / 1000) * sampleRate);
  // The frames still to go out, oldest first, and whether each opens the gate.
  const pending = Array.from({ length: LOOKAHEAD_FRAMES }, () => new Float32Array(frameSize));
  const pendingOpens = Array(LOOKAHEAD_FRAMES).fill(false);
  const out = new Float32Array(frameSize);
  let lastSpeech = 0;
  let hold = 0;
  let gain = 0;
  let open = false;

  const opens = (speech, db) => {
    if (!options.auto) return options.thresholdDb <= ALWAYS_OPEN_DB || db >= options.thresholdDb;
    if (open) return speech >= KEEP_SPEECH;
    return speech >= OPEN_SPEECH && lastSpeech >= OPEN_SPEECH;
  };

  return {
    setOptions(next) {
      options = { ...options, ...next };
    },
    get open() {
      return open;
    },
    // Takes this frame (with its speech probability, 0–1, and loudness in dB) and returns the
    // one from LOOKAHEAD_FRAMES before it, gated.
    process(frame, speech, db) {
      const now = opens(speech, db);
      lastSpeech = speech;
      // A frame of speech opens the gate for itself and the frame before it (the one going
      // out now, when it opens on its second frame of speech).
      const ahead = now || pendingOpens.some(Boolean);
      open = ahead || hold > 0;
      if (ahead) hold = holdFrames;
      else if (hold > 0) hold--;
      const target = open ? 1 : 0;
      const oldest = pending[0];
      for (let i = 0; i < frameSize; i++) {
        if (gain < target) gain = Math.min(target, gain + attackStep);
        else if (gain > target) gain = Math.max(target, gain - releaseStep);
        out[i] = oldest[i] * gain;
      }
      // Shift the queue: the oldest buffer is reused for this frame.
      pending.push(pending.shift());
      pending[LOOKAHEAD_FRAMES - 1].set(frame);
      pendingOpens.shift();
      pendingOpens.push(now);
      return out;
    },
  };
}
