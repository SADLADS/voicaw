import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/api', () => ({ default: {} }));
vi.mock('../utils/ws-client', () => ({ onConnectionState: () => () => {}, onGuildEvent: () => () => {} }));

const { encodeWav, fitsAsIs, monoClip, soundNameFromFile, uploadType, MAX_BYTES } = await import('./soundClip');

// An AudioBuffer's face: `channels` arrays of samples.
const bufferOf = (channels, sampleRate = 48000) => ({
  sampleRate,
  length: channels[0].length,
  numberOfChannels: channels.length,
  getChannelData: (c) => Float32Array.from(channels[c]),
});

describe('soundClip', () => {
  it('uploads small, short MP3s and WAVs as they are', () => {
    expect(fitsAsIs({ type: 'audio/mpeg', size: 100 * 1024 }, 3)).toBe(true);
    expect(fitsAsIs({ type: 'audio/wav', size: 100 * 1024 }, 5.2)).toBe(true);
    expect(fitsAsIs({ type: 'audio/mpeg', size: MAX_BYTES + 1 }, 3)).toBe(false);
    expect(fitsAsIs({ type: 'audio/mpeg', size: 1000 }, 6)).toBe(false);
    // Safari can't always play Ogg: made a WAV.
    expect(fitsAsIs({ type: 'audio/ogg', size: 1000 }, 1)).toBe(false);
    expect(uploadType({ type: 'audio/mp3' })).toBe('audio/mpeg');
    expect(uploadType({ type: 'audio/x-wav' })).toBe('audio/wav');
  });

  it('mixes to mono from the start chosen, at most 5.2 s, fading the edges', () => {
    const rate = 1000;
    const left = new Array(10 * rate).fill(1);
    const right = new Array(10 * rate).fill(0);
    const clip = monoClip(bufferOf([left, right], rate), 2);
    expect(clip.length).toBe(5200);
    expect(clip[2600]).toBeCloseTo(0.5);
    expect(clip[0]).toBe(0);
    expect(clip[clip.length - 1]).toBe(0);
    // Near the end there's less left.
    expect(monoClip(bufferOf([left], rate), 8).length).toBe(2000);
  });

  it('writes a 16-bit mono WAV', () => {
    const bytes = encodeWav(Float32Array.from([0, 1, -1, 0.5]), 48000);
    const view = new DataView(bytes);
    const text = (at, n) => String.fromCharCode(...new Uint8Array(bytes, at, n));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 16383]);
    // 5.2 s of it fits the server's 512 KB.
    expect(44 + 5.2 * 48000 * 2).toBeLessThan(MAX_BYTES);
  });

  it('names a sound after its file', () => {
    expect(soundNameFromFile('air_horn-loud.mp3')).toBe('air horn loud');
    expect(soundNameFromFile('x.wav')).toBe('Sound');
    expect(soundNameFromFile(`${'a'.repeat(40)}.mp3`)).toHaveLength(32);
  });
});
