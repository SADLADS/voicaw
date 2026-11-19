import { describe, it, expect } from 'vitest';

const { imageJob, ImageBusyError, MAX_RUNNING, MAX_WAITING } = require('../imageQueue.js');

describe('the picture queue', () => {
  it(`runs ${MAX_RUNNING} jobs at once, keeps ${MAX_WAITING} waiting and refuses the rest`, async () => {
    let running = 0;
    let most = 0;
    const releases = [];
    const job = () => imageJob(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => releases.push(resolve));
      running -= 1;
      return 'done';
    });
    const accepted = Array.from({ length: MAX_RUNNING + MAX_WAITING }, job);
    await expect(job()).rejects.toBeInstanceOf(ImageBusyError);
    // Let every job through, one release at a time as each starts.
    for (let i = 0; i < accepted.length; i++) {
      while (releases.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      releases.shift()();
    }
    expect(await Promise.all(accepted)).toEqual(accepted.map(() => 'done'));
    expect(most).toBe(MAX_RUNNING);
    // Room again afterwards, and a failing job frees its place.
    await expect(imageJob(async () => { throw new Error('bad'); })).rejects.toThrow('bad');
    expect(await imageJob(async () => 'again')).toBe('again');
  });
});
