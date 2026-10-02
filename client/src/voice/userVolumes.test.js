import { describe, expect, it } from 'vitest';
import { cleanUserVolumes, playbackVolume } from './userVolumes';

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
