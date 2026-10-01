import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createReblocker, frameDb } from './frames';
import { ALWAYS_OPEN_DB, createGate } from './gate';
import { createRnnoise } from './rnnoise';

const RATE = 48000;
const FRAME = 480;

// Runs `samples` through `run(input, output)` in blocks of `block`, returning the output.
function inBlocks(run, samples, block = 128) {
  const out = new Float32Array(samples.length);
  for (let at = 0; at + block <= samples.length; at += block) {
    run(samples.subarray(at, at + block), out.subarray(at, at + block));
  }
  return out;
}

describe('createReblocker', () => {
  it('passes audio through in frames, one frame late, for any block size', () => {
    for (const block of [128, 256, 441, 480]) {
      const input = Float32Array.from({ length: FRAME * 20 }, (_, i) => i + 1);
      const sizes = [];
      const run = createReblocker(FRAME, (frame) => {
        sizes.push(frame.length);
        return frame;
      });
      const output = inBlocks(run, input, block);
      const usable = Math.floor(input.length / block) * block;
      expect(sizes.every((s) => s === FRAME)).toBe(true);
      expect(Array.from(output.subarray(0, FRAME)).every((v) => v === 0)).toBe(true);
      for (let i = FRAME; i < usable; i++) expect(output[i]).toBe(input[i - FRAME]);
    }
  });
});

describe('frameDb', () => {
  it('measures loudness in dBFS', () => {
    expect(frameDb(new Float32Array(FRAME))).toBe(-100);
    expect(frameDb(new Float32Array(FRAME).fill(1))).toBeCloseTo(0);
    expect(frameDb(new Float32Array(FRAME).fill(0.01))).toBeCloseTo(-40);
  });
});

describe('createGate', () => {
  const ones = () => new Float32Array(FRAME).fill(1);
  // Feeds frames with these speech probabilities (or levels); returns each output frame's
  // average gain.
  const run = (gate, frames) => frames.map(([speech, db]) => {
    const out = gate.process(ones(), speech, db);
    return out.reduce((a, b) => a + b, 0) / FRAME;
  });

  it('stays shut without speech, and opens a frame before it starts', () => {
    const gate = createGate({ frameSize: FRAME, sampleRate: RATE });
    const gains = run(gate, [[0, -20], [0, -20], [0, -20], [0.9, -20], [0.9, -20], [0.9, -20], [0.9, -20]]);
    // Output is two frames behind: output 4 is input 2, the frame before the speech.
    expect(gains.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(gains[4]).toBeGreaterThan(0.5);
    expect(gains[5]).toBe(1);
  });

  it('ignores a single frame that sounds like speech (a key click)', () => {
    const gate = createGate({ frameSize: FRAME, sampleRate: RATE });
    const frames = Array.from({ length: 60 }, (_, i) => [i % 10 === 5 ? 0.95 : 0.1, -20]);
    expect(run(gate, frames).every((g) => g === 0)).toBe(true);
  });

  it('holds on after speech, then fades out', () => {
    const gate = createGate({ frameSize: FRAME, sampleRate: RATE });
    const gains = run(gate, [[0.9, -20], [0.9, -20], ...Array(60).fill([0, -20])]);
    // 300 ms hold (30 frames), then an 80 ms fade.
    expect(gains[20]).toBe(1);
    expect(gains[50]).toBe(0);
  });

  it('keeps open on weaker speech once open, but needs a clear start', () => {
    const gate = createGate({ frameSize: FRAME, sampleRate: RATE });
    expect(run(gate, Array(40).fill([0.4, -20])).every((g) => g === 0)).toBe(true);
    const after = run(gate, [[0.9, -20], [0.9, -20], ...Array(80).fill([0.4, -20])]);
    expect(after.at(-1)).toBe(1);
  });

  it('opens on loudness when set by hand, or never shuts at the bottom', () => {
    const gate = createGate({ frameSize: FRAME, sampleRate: RATE });
    gate.setOptions({ auto: false, thresholdDb: -40 });
    expect(run(gate, Array(10).fill([1, -60])).every((g) => g === 0)).toBe(true);
    expect(run(gate, Array(10).fill([0, -30])).at(-1)).toBe(1);
    gate.setOptions({ thresholdDb: ALWAYS_OPEN_DB });
    expect(run(gate, Array(60).fill([0, -100])).at(-1)).toBe(1);
  });
});

describe('createRnnoise (the real WebAssembly)', () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('@sapphi-red/web-noise-suppressor/rnnoise.wasm');
  const module = new WebAssembly.Module(fs.readFileSync(wasmPath));
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };

  // A voice-like sound: a wandering pitch with harmonics, in syllables (like e2e's fake mic).
  const voiceFrames = () => {
    let phase = 0;
    return (n) => Float32Array.from({ length: FRAME }, (_, i) => {
      const t = (n * FRAME + i) / RATE;
      const envelope = Math.sin(Math.PI * ((t * 4) % 1)) ** 2;
      phase += (2 * Math.PI * (120 + 40 * Math.sin(2 * Math.PI * 0.7 * t))) / RATE;
      let sample = 0;
      for (let h = 1; h <= 12; h++) sample += Math.sin(h * phase) / h;
      return 0.2 * envelope * sample;
    });
  };

  // Through RNNoise and the gate (automatic) as the worklet does; the share of output that
  // got through.
  const gated = (makeFrame, frames = 300) => {
    const rnnoise = createRnnoise(module);
    const gate = createGate({ frameSize: FRAME, sampleRate: RATE });
    let open = 0;
    for (let n = 0; n < frames; n++) {
      const frame = makeFrame(n);
      const speech = rnnoise.process(frame);
      gate.process(frame, speech, frameDb(frame));
      if (gate.open) open++;
    }
    rnnoise.destroy();
    return open / frames;
  };

  it('keeps the gate shut for key clicks and open for a voice', () => {
    const clicks = gated((n) => {
      const frame = new Float32Array(FRAME);
      if (n % 15 === 0) for (let i = 0; i < 240; i++) frame[i] = random() * 0.8 * Math.exp(-i / 40);
      return frame;
    });
    expect(clicks).toBe(0);
    expect(gated(voiceFrames())).toBeGreaterThan(0.8);
  });

  it('quietens a fan and leaves a voice', () => {
    const rnnoise = createRnnoise(module);
    expect(rnnoise.frameSize).toBe(FRAME);
    // Average loudness (dB) of frames 100–199, before and after.
    const loudness = (makeFrame) => {
      let before = 0;
      let after = 0;
      for (let n = 0; n < 200; n++) {
        const frame = makeFrame(n);
        if (n >= 100) before += frameDb(frame);
        rnnoise.process(frame);
        if (n >= 100) after += frameDb(frame);
      }
      return [before / 100, after / 100];
    };
    // Low-passed noise, like a fan. (Flat white noise is a poor test: RNNoise takes it for an
    // "s" about as often as for noise.)
    let low = 0;
    const [fanBefore, fanAfter] = loudness(() => Float32Array.from({ length: FRAME }, () => {
      low += 0.05 * (random() - low);
      return low * 0.6;
    }));
    expect(fanAfter).toBeLessThan(fanBefore - 30);
    const [voiceBefore, voiceAfter] = loudness(voiceFrames());
    expect(voiceAfter).toBeGreaterThan(voiceBefore - 6);
    rnnoise.destroy();
    expect(rnnoise.process(new Float32Array(FRAME))).toBe(0);
  });
});
