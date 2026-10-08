import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canBoostVolume, maxUserVolume, cleanUserVolumes, getStreamVolume, getUserVolume, onStreamVolumesChange, playbackVolume, setStreamVolume,
} from './userVolumes';

describe('stream volumes', () => {
  it('are kept apart from the person’s own volume', () => {
    let changes = 0;
    const stop = onStreamVolumesChange(() => { changes += 1; });
    setStreamVolume(5, 0.4);
    expect(getStreamVolume('5')).toBe(0.4);
    expect(getUserVolume('5')).toBe(1);
    expect(changes).toBe(1);
    setStreamVolume(5, 1);
    expect(getStreamVolume('5')).toBe(1);
    stop();
  });
});

describe('cleanUserVolumes', () => {
  it('keeps user ids with volumes, clamped to 0–200%, and drops 100%', () => {
    expect(cleanUserVolumes({ 1: 0.5, 2: 3, 3: -1, 4: 1, x: 0.5, 5: 'loud', 6: NaN })).toEqual({ 1: 0.5, 2: 2, 3: 0 });
  });

  it('takes anything else as nothing saved', () => {
    expect(cleanUserVolumes(null)).toEqual({});
    expect(cleanUserVolumes([0.5])).toEqual({});
    expect(cleanUserVolumes('x')).toEqual({});
  });
});

describe('playbackVolume', () => {
  it('multiplies the output volume by the person’s', () => {
    expect(playbackVolume({ selfDeaf: false, outputVolume: 0.5, userVolume: 1.5, canBoost: true })).toBe(0.75);
    expect(playbackVolume({ selfDeaf: false, outputVolume: 0.8, canBoost: true })).toBe(0.8);
  });

  it('goes past 100% only through Web Audio, and never past 200%', () => {
    expect(playbackVolume({ selfDeaf: false, outputVolume: 1, userVolume: 2, canBoost: true })).toBe(2);
    expect(playbackVolume({ selfDeaf: false, outputVolume: 1, userVolume: 2, canBoost: false })).toBe(1);
  });

  it('is silent while deafened or at 0%', () => {
    expect(playbackVolume({ selfDeaf: true, outputVolume: 1, userVolume: 2, canBoost: true })).toBe(0);
    expect(playbackVolume({ selfDeaf: false, outputVolume: 1, userVolume: 0, canBoost: true })).toBe(0);
  });
});

describe('canBoostVolume', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('boosts through Web Audio that can choose the speakers (Chrome)', () => {
    vi.stubGlobal('AudioContext', class { setSinkId() {} });
    vi.stubGlobal('HTMLMediaElement', class { setSinkId() {} });
    expect(canBoostVolume()).toBe(true);
    expect(maxUserVolume()).toBe(2);
  });

  it('boosts through Web Audio where no speakers can be chosen at all', () => {
    vi.stubGlobal('AudioContext', class {});
    expect(canBoostVolume()).toBe(true);
  });

  it('stops at 100% where only media elements can choose the speakers (Firefox), or without Web Audio', () => {
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('HTMLMediaElement', class { setSinkId() {} });
    expect(canBoostVolume()).toBe(false);
    expect(maxUserVolume()).toBe(1);
    vi.unstubAllGlobals();
    vi.stubGlobal('AudioContext', undefined);
    expect(maxUserVolume()).toBe(1);
  });
});
