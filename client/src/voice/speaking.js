// Who's talking, measured on this device: the green ring follows each voice as it's heard,
// rather than waiting for LiveKit's active speakers (the server sends those a few times a
// second, smoothed, so the ring came and went most of a second late).
//
// A meter per voice (a Web Audio analyser on its track: others' microphones as received, ours
// as sent, after the gate) is read every METER_INTERVAL_MS. Someone's talking from the moment
// their level reaches SPEAKING_DB until it's been below it for SPEAKING_HOLD_MS (so the pauses
// between words don't make the ring flicker). Voices that can't be measured (no track yet, or
// the AudioContext isn't running because the browser wants a click first) aren't counted here:
// voiceClient.js falls back to LiveKit's list for those.

export const SPEAKING_DB = -50;
export const SPEAKING_HOLD_MS = 250;
export const METER_INTERVAL_MS = 50;

// A block of samples' loudness in dB (RMS), -Infinity for silence.
export function dbOf(samples) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / (samples.length || 1));
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

// Whether one voice is talking, from its level over time: `(db, now) => boolean`.
export function createSpeakingState({ thresholdDb = SPEAKING_DB, holdMs = SPEAKING_HOLD_MS } = {}) {
  let lastLoud = -Infinity;
  return (db, now) => {
    if (db >= thresholdDb) lastLoud = now;
    return now - lastLoud < holdMs;
  };
}

// The meters. `context()` gives the AudioContext to measure in (or null); `onChange()` is
// called when who's talking, or who can be measured, changes. Each meter is added under a key
// (a track) with the user id it belongs to and `getTrack()`, which returns its current
// MediaStreamTrack or null (it's asked every time, since ours is replaced when the microphone
// is captured again). `silentWithoutTrack`: no track means not talking (our own microphone,
// off), rather than not measured.
export function createSpeakingMeters({ context, onChange, interval = METER_INTERVAL_MS, now = () => performance.now() }) {
  const meters = new Map();
  let speaking = new Set();
  let measured = new Set();
  let timer = null;

  const disconnect = (meter) => {
    meter.source?.disconnect();
    meter.source = null;
    meter.track = null;
  };

  // The meter's analyser on `track`.
  const analyserFor = (meter, ctx, track) => {
    if (meter.track !== track || meter.context !== ctx) {
      disconnect(meter);
      meter.context = ctx;
      meter.analyser = ctx.createAnalyser();
      meter.analyser.fftSize = 1024;
      meter.samples = new Float32Array(meter.analyser.fftSize);
      meter.source = ctx.createMediaStreamSource(new MediaStream([track]));
      meter.source.connect(meter.analyser);
      meter.track = track;
    }
    return meter.analyser;
  };

  const sameSet = (a, b) => a.size === b.size && [...a].every((id) => b.has(id));

  const tick = () => {
    const ctx = context();
    const time = now();
    const nextSpeaking = new Set();
    const nextMeasured = new Set();
    for (const meter of meters.values()) {
      const track = meter.getTrack();
      if (!track || track.readyState === 'ended') {
        disconnect(meter);
        if (meter.silentWithoutTrack) nextMeasured.add(meter.identity);
        continue;
      }
      if (ctx?.state !== 'running') continue;
      const analyser = analyserFor(meter, ctx, track);
      analyser.getFloatTimeDomainData(meter.samples);
      nextMeasured.add(meter.identity);
      if (meter.isSpeaking(dbOf(meter.samples), time)) nextSpeaking.add(meter.identity);
    }
    if (sameSet(nextSpeaking, speaking) && sameSet(nextMeasured, measured)) return;
    speaking = nextSpeaking;
    measured = nextMeasured;
    onChange();
  };

  return {
    add(key, identity, getTrack, { silentWithoutTrack = false } = {}) {
      if (meters.has(key)) return;
      meters.set(key, {
        identity, getTrack, silentWithoutTrack, isSpeaking: createSpeakingState(), source: null, track: null,
      });
      timer ??= setInterval(tick, interval);
    },
    remove(key) {
      const meter = meters.get(key);
      if (!meter) return;
      disconnect(meter);
      meters.delete(key);
      if (meters.size === 0) {
        clearInterval(timer);
        timer = null;
        tick();
      }
    },
    // The user ids talking, and those whose voice could be measured.
    speaking: () => speaking,
    measured: () => measured,
    destroy() {
      clearInterval(timer);
      timer = null;
      for (const meter of meters.values()) disconnect(meter);
      meters.clear();
      speaking = new Set();
      measured = new Set();
    },
  };
}

// Everyone talking: the measured voices, and LiveKit's speakers among those we can't measure.
export function whoIsSpeaking(meters, liveKitSpeakers) {
  const measured = meters?.measured() ?? new Set();
  const speaking = new Set(meters?.speaking() ?? []);
  for (const identity of liveKitSpeakers) {
    if (!measured.has(identity)) speaking.add(identity);
  }
  return [...speaking].sort();
}
