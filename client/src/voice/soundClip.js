import { MAX_SECONDS } from './soundboard';

// Getting a file ready to be a soundboard sound (Guild Settings → Soundboard). The server takes
// MP3, Ogg and WAV files up to 512 KB and the apps play 5.2 seconds at most (Discord's limits).
// An MP3 or WAV that fits is uploaded as it is; anything else the browser can decode (longer,
// bigger, Ogg, which Safari can't always play, M4A, FLAC, a video's sound...) is cut to 5.2 s from
// where its sound starts and made a mono 16-bit WAV at 48 kHz, which always fits (5.2 s is 499 KB).

export const MAX_BYTES = 512 * 1024;
export const ACCEPT = 'audio/*,video/mp4,video/webm';
const AS_IS = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave']);
const RATE = 48000;
const FADE_SECONDS = 0.01;
const SILENCE = 0.01; // -40 dBFS: quieter than this before the sound starts is skipped
const LEAD_IN_SECONDS = 0.05;

// The file's sound, decoded at 48 kHz (whatever it was). Throws if the browser can't read it.
export async function decodeSoundFile(file) {
  const data = await file.arrayBuffer();
  const Offline = window.OfflineAudioContext ?? window.webkitOfflineAudioContext;
  const context = new Offline(1, 1, RATE);
  return context.decodeAudioData(data);
}

// Whether `file` (with `duration`, seconds) can be uploaded as it is.
export function fitsAsIs(file, duration) {
  return AS_IS.has(file.type) && file.size <= MAX_BYTES && duration <= MAX_SECONDS + 0.05;
}

// The type the server should be told for a file uploaded as it is.
export const uploadType = (file) => (file.type === 'audio/mpeg' || file.type === 'audio/mp3' ? 'audio/mpeg' : 'audio/wav');

// `buffer`'s channels mixed into one, from `start` for `length` seconds (at most MAX_SECONDS),
// faded in and out over 10 ms so the cut doesn't click.
export function monoClip(buffer, start = 0, length = MAX_SECONDS) {
  const rate = buffer.sampleRate;
  const from = Math.max(0, Math.min(Math.round(start * rate), buffer.length));
  const count = Math.max(0, Math.min(Math.round(Math.min(length, MAX_SECONDS) * rate), buffer.length - from));
  const samples = new Float32Array(count);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < count; i++) samples[i] += channel[from + i] / buffer.numberOfChannels;
  }
  const fade = Math.min(Math.round(FADE_SECONDS * rate), Math.floor(count / 2));
  for (let i = 0; i < fade; i++) {
    samples[i] *= i / fade;
    samples[count - 1 - i] *= i / fade;
  }
  return samples;
}

// Mono samples (-1–1) as a 16-bit PCM WAV file's bytes.
export function encodeWav(samples, sampleRate = RATE) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // the format chunk's size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes a second
  view.setUint16(32, 2, true); // bytes a frame
  view.setUint16(34, 16, true); // bits a sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

// The part of `buffer` from `start` as a WAV Blob, ready to upload.
export const clipFile = (buffer, start) => new Blob([encodeWav(monoClip(buffer, start), buffer.sampleRate)], { type: 'audio/wav' });

// Where a cut should start: just before `buffer`'s first sample louder than silence, but early
// enough to keep MAX_SECONDS when the file has them.
export function soundStart(buffer) {
  const rate = buffer.sampleRate;
  let first = buffer.length;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < Math.min(first, channel.length); i++) {
      if (Math.abs(channel[i]) > SILENCE) {
        first = i;
        break;
      }
    }
  }
  if (first === buffer.length) return 0;
  const latest = Math.max(0, buffer.length / rate - MAX_SECONDS);
  return Math.min(Math.max(0, first / rate - LEAD_IN_SECONDS), latest);
}

// A picked file as the Blob to upload: as it is when it fits, otherwise MAX_SECONDS of it from
// where its sound starts. Throws if the browser can't read it.
export async function soundUpload(file) {
  const buffer = await decodeSoundFile(file);
  if (fitsAsIs(file, buffer.duration)) return new Blob([file], { type: uploadType(file) });
  return clipFile(buffer, soundStart(buffer));
}

// A sound's name from its file's: no extension, separators as spaces, 2–32 characters.
export function soundNameFromFile(fileName) {
  const name = String(fileName ?? '').replace(/\.[^.]*$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32).trim();
  return name.length >= 2 ? name : 'Sound';
}
