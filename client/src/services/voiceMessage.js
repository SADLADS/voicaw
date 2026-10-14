// Voice messages (as Discord's): recorded on the device (MediaRecorder), sent as an ordinary
// encrypted attachment, its own message, with its length and a waveform in the attachment URL
// (`vm=1&d=…&wf=…`, see attachmentCrypto.js). The waveform is measured while recording, so
// the file is never decoded for it.

import { toBase64Url, fromBase64Url } from './chunkedAttachment';
import { captureOptions } from '../voice/audioSettings';

// Discord's longest; a recording stops there and waits to be sent.
export const MAX_VOICE_SECONDS = 20 * 60;
// A hold shorter than this was a tap: nothing is sent.
export const MIN_VOICE_SECONDS = 0.5;
// The waveform's slices (one byte each, 86 characters in the URL).
export const WAVEFORM_LENGTH = 64;
// How often the level is measured while recording.
export const LEVEL_INTERVAL_MS = 100;
// Opus at this rate is clear speech: 20 minutes is about 7 MB.
const BITS_PER_SECOND = 48000;

// What this browser records in, the first it has: Opus in WebM (Chrome, Android, Firefox),
// Opus in Ogg (Firefox), AAC in MP4 (Safari). '' leaves it to the browser.
const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'];
export function recordingType(isSupported = (type) => globalThis.MediaRecorder?.isTypeSupported?.(type)) {
  return TYPES.find((type) => isSupported(type)) ?? '';
}

// The file's name: what someone saving it gets ("voice-message.webm").
export function voiceFileName(type) {
  const ext = /^audio\/(webm|ogg|mp4|mpeg|aac|wav)/.exec(type ?? '')?.[1];
  return `voice-message.${ext === 'mp4' ? 'm4a' : ext === 'mpeg' ? 'mp3' : ext ?? 'webm'}`;
}

// A recording whose loudest moment is quieter than this (about -36 dB) isn't stretched to the
// full height: near-silence stays a flat line rather than its noise drawn as speech.
const QUIET_RMS = 0.015;

// The loudest of `values`, but never under QUIET_RMS (a loop: 20 minutes is 12000 levels).
function loudestOf(values) {
  let loudest = QUIET_RMS;
  for (const value of values) if (value > loudest) loudest = value;
  return loudest;
}

// Loudness measured (RMS, one per LEVEL_INTERVAL_MS) as heights 0..1, relative to the loudest
// (as WhatsApp's and Telegram's waveforms are). Linear, not decibels: the microphone's auto
// gain makes ordinary speech loud, and a decibel scale drew all of it full height.
export function relativeLevels(rms) {
  const loudest = loudestOf(rms);
  return rms.map((value) => Math.min(1, Math.max(0, value) / loudest));
}

// The loudness measured (RMS, one per LEVEL_INTERVAL_MS) as `length` bytes: each the average
// (RMS) of its share of the recording (a short one repeats levels instead), relative to the
// loudest share. The average, not the loudest of each share, so pauses between words show.
export function waveformFrom(rms, length = WAVEFORM_LENGTH) {
  const out = new Uint8Array(length);
  const n = rms.length;
  if (n === 0) return out;
  const shares = [];
  for (let i = 0; i < length; i++) {
    const from = Math.floor((i * n) / length);
    const to = Math.min(n, Math.max(from + 1, Math.floor(((i + 1) * n) / length)));
    let energy = 0;
    for (let j = from; j < to; j++) energy += rms[j] ** 2;
    shares.push(Math.sqrt(energy / (to - from)));
  }
  relativeLevels(shares).forEach((level, i) => {
    out[i] = Math.round(level * 255);
  });
  return out;
}

export function encodeWaveform(bytes) {
  return toBase64Url(bytes);
}

// A waveform from a URL (anyone could have written it): up to 256 bytes, else null.
export function decodeWaveform(text) {
  if (!/^[A-Za-z0-9_-]{2,342}$/.test(text ?? '')) return null;
  try {
    const bytes = fromBase64Url(text);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

// `count` bars (0..1) to draw from a waveform (bytes, or levels 0..1 with `max` 1), each the
// average of its share. No waveform: a flat line of quiet bars.
export function waveformBars(waveform, count, max = 255) {
  const n = waveform?.length ?? 0;
  if (n === 0) return new Array(count).fill(0.15);
  const bars = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * n) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * n) / count));
    const end = Math.min(to, n);
    let sum = 0;
    for (let j = from; j < end; j++) sum += waveform[j];
    bars.push(sum / (end - from) / max);
  }
  return bars;
}

// A MediaRecorder file from Chrome has no length in it (its <audio> says Infinity, and won't
// seek): asking for a time past the end makes it read through and find it.
export function findDuration(audio) {
  if (Number.isFinite(audio.duration)) return Promise.resolve(audio.duration);
  return new Promise((resolve) => {
    const done = () => {
      if (!Number.isFinite(audio.duration)) return;
      audio.removeEventListener('durationchange', done);
      audio.removeEventListener('timeupdate', done);
      audio.currentTime = 0;
      resolve(audio.duration);
    };
    audio.addEventListener('durationchange', done);
    audio.addEventListener('timeupdate', done);
    audio.currentTime = 1e101;
  });
}

// Starts recording from the microphone (Settings → Voice's, with the browser's echo
// cancellation, noise suppression and gain: it's a message, not a call). `onLevel(levels,
// seconds)` hears every LEVEL_INTERVAL_MS (`levels`: the loudness so far, RMS; see
// relativeLevels). Resolves (once recording) to { stop, cancel }:
// `stop()` resolves to { file, duration, waveform }; `cancel()` throws it away. Either lets
// the microphone go. Rejects if the microphone can't be had.
export async function startVoiceRecorder({ onLevel } = {}) {
  const { deviceId } = captureOptions();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...(deviceId ? { deviceId } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let context = null;
  let timer = null;
  const release = () => {
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    context?.close().catch(() => {});
  };

  let recorder;
  try {
    const type = recordingType();
    recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: BITS_PER_SECOND });
  } catch (err) {
    release();
    throw err;
  }
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };

  // The level, from an analyser beside the recorder (the recording isn't touched).
  const levels = [];
  let analyser = null;
  try {
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
  } catch {
    analyser = null; // no waveform, still a recording
  }
  const samples = new Float32Array(2048);

  await new Promise((resolve, reject) => {
    recorder.onstart = resolve;
    recorder.onerror = (e) => reject(e.error ?? new Error('MediaRecorder failed'));
    try {
      recorder.start(1000);
    } catch (err) {
      reject(err);
    }
  }).catch((err) => {
    release();
    throw err;
  });
  const startedAt = performance.now();
  const seconds = () => (performance.now() - startedAt) / 1000;
  timer = setInterval(() => {
    let level = 0;
    if (analyser) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      level = Math.sqrt(sum / samples.length);
    }
    // One level per LEVEL_INTERVAL_MS of recording, however late the timer ran (a page out
    // of sight gets fewer ticks): the gap takes this level, so the waveform keeps time with
    // the audio.
    const due = Math.max(levels.length + 1, Math.floor((seconds() * 1000) / LEVEL_INTERVAL_MS));
    while (levels.length < due) levels.push(level);
    onLevel?.(levels, seconds());
  }, LEVEL_INTERVAL_MS);

  let ended = false;
  return {
    stop() {
      if (ended) return Promise.reject(new Error('Already stopped'));
      ended = true;
      const duration = seconds();
      clearInterval(timer);
      return new Promise((resolve) => {
        recorder.onstop = () => {
          release();
          const type = (recorder.mimeType || chunks[0]?.type || 'audio/webm').replace(/\s+/g, '');
          const file = new File(chunks, voiceFileName(type), { type });
          resolve({ file, duration, waveform: waveformFrom(levels) });
        };
        recorder.stop();
      });
    },
    cancel() {
      if (ended) return;
      ended = true;
      recorder.onstop = release;
      try {
        recorder.stop();
      } catch {
        release();
      }
    },
  };
}
