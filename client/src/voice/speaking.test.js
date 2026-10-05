import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSpeakingMeters, createSpeakingState, dbOf, whoIsSpeaking } from './speaking';

// A stand-in AudioContext whose analysers report each track's current `level` (a sample value).
function fakeContext() {
  const sources = [];
  return {
    state: 'running',
    sources,
    createMediaStreamSource: vi.fn((stream) => {
      const source = { track: stream.tracks[0], connect: vi.fn((analyser) => { analyser.source = source; }), disconnect: vi.fn() };
      sources.push(source);
      return source;
    }),
    createAnalyser: () => ({
      fftSize: 0,
      getFloatTimeDomainData(samples) {
        samples.fill(this.source.track.level);
      },
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.MediaStream = class {
    constructor(tracks) {
      this.tracks = tracks;
    }
  };
});

afterEach(() => vi.useRealTimers());

describe('dbOf', () => {
  it('measures loudness in dB', () => {
    expect(dbOf(new Float32Array(8).fill(1))).toBeCloseTo(0);
    expect(dbOf(new Float32Array(8).fill(0.01))).toBeCloseTo(-40);
    expect(dbOf(new Float32Array(8))).toBe(-Infinity);
  });
});

describe('createSpeakingState', () => {
  it('turns on at once and off after the hold', () => {
    const isSpeaking = createSpeakingState({ thresholdDb: -50, holdMs: 250 });
    expect(isSpeaking(-70, 0)).toBe(false);
    expect(isSpeaking(-30, 50)).toBe(true);
    expect(isSpeaking(-70, 200)).toBe(true);
    expect(isSpeaking(-70, 299)).toBe(true);
    expect(isSpeaking(-70, 300)).toBe(false);
  });
});

describe('createSpeakingMeters', () => {
  const loud = 0.1; // -20 dB
  const quiet = 0.0001; // -80 dB

  it('reports who is talking as soon as they are heard, and only on changes', () => {
    const context = fakeContext();
    const onChange = vi.fn();
    let time = 0;
    const meters = createSpeakingMeters({ context: () => context, onChange, now: () => time });
    const alice = { level: quiet };
    const bob = { level: quiet };
    meters.add('a', 'alice', () => alice);
    meters.add('b', 'bob', () => bob);

    time = 50;
    vi.advanceTimersByTime(50);
    expect([...meters.measured()].sort()).toEqual(['alice', 'bob']);
    expect(meters.speaking().size).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1);

    alice.level = loud;
    time = 100;
    vi.advanceTimersByTime(50);
    expect([...meters.speaking()]).toEqual(['alice']);
    expect(onChange).toHaveBeenCalledTimes(2);

    alice.level = quiet;
    time = 150;
    vi.advanceTimersByTime(50);
    expect(onChange).toHaveBeenCalledTimes(2); // still held
    time = 400;
    vi.advanceTimersByTime(50);
    expect(meters.speaking().size).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(3);
    meters.destroy();
  });

  it('follows a replaced track and skips voices without one', () => {
    const context = fakeContext();
    let track = null;
    const meters = createSpeakingMeters({ context: () => context, onChange: () => {} });
    meters.add('me', 'me', () => track);
    vi.advanceTimersByTime(50);
    expect(meters.measured().size).toBe(0);

    track = { level: loud };
    vi.advanceTimersByTime(50);
    expect([...meters.speaking()]).toEqual(['me']);

    const first = context.sources[0];
    track = { level: loud };
    vi.advanceTimersByTime(50);
    expect(first.disconnect).toHaveBeenCalled();
    expect(context.sources).toHaveLength(2);
    meters.destroy();
  });

  it('counts a voice without a track as silent when asked to', () => {
    const context = fakeContext();
    let track = { level: loud };
    const meters = createSpeakingMeters({ context: () => context, onChange: () => {} });
    meters.add('me', 'me', () => track, { silentWithoutTrack: true });
    vi.advanceTimersByTime(50);
    expect([...meters.speaking()]).toEqual(['me']);
    track = null;
    vi.advanceTimersByTime(50);
    expect(meters.speaking().size).toBe(0);
    expect([...meters.measured()]).toEqual(['me']);
    meters.destroy();
  });

  it('measures nothing while the AudioContext is not running', () => {
    const context = { ...fakeContext(), state: 'suspended' };
    const meters = createSpeakingMeters({ context: () => context, onChange: () => {} });
    meters.add('a', 'alice', () => ({ level: loud }));
    vi.advanceTimersByTime(50);
    expect(meters.measured().size).toBe(0);
    expect(context.createMediaStreamSource).not.toHaveBeenCalled();
    meters.destroy();
  });

  it('forgets a removed voice', () => {
    const context = fakeContext();
    const meters = createSpeakingMeters({ context: () => context, onChange: () => {} });
    meters.add('a', 'alice', () => ({ level: loud }));
    vi.advanceTimersByTime(50);
    expect([...meters.speaking()]).toEqual(['alice']);
    meters.remove('a');
    expect(meters.speaking().size).toBe(0);
    expect(context.sources[0].disconnect).toHaveBeenCalled();
    meters.destroy();
  });
});

describe('whoIsSpeaking', () => {
  it('uses LiveKit only for voices that are not measured', () => {
    const meters = { speaking: () => new Set(['alice']), measured: () => new Set(['alice', 'bob']) };
    expect(whoIsSpeaking(meters, ['bob', 'carol'])).toEqual(['alice', 'carol']);
    expect(whoIsSpeaking(null, ['bob'])).toEqual(['bob']);
  });
});
