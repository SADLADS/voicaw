import { describe, expect, it } from 'vitest';
import { joinRefused, rejoinDelay, shouldRejoin } from './rejoin';

describe('shouldRejoin', () => {
  it('rejoins after a lost connection', () => {
    for (const reason of [undefined, 0, 3, 6, 7, 8, 9, 14, 15]) expect(shouldRejoin(reason)).toBe(true);
  });

  it('stays out when leaving was meant', () => {
    for (const reason of [1, 2, 4, 5, 10]) expect(shouldRejoin(reason)).toBe(false);
  });
});

describe('rejoinDelay', () => {
  it('tries at once, then backs off to 10 s', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(rejoinDelay)).toEqual([0, 1000, 2000, 5000, 10000, 10000, 10000]);
  });
});

describe('joinRefused', () => {
  const failed = (status) => ({ response: { status } });

  it('gives up when the API refuses', () => {
    for (const status of [400, 401, 403, 404, 503]) expect(joinRefused(failed(status))).toBe(true);
  });

  it('keeps trying without an answer or on a passing error', () => {
    expect(joinRefused(new Error('Network Error'))).toBe(false);
    for (const status of [408, 429, 500, 502, 504]) expect(joinRefused(failed(status))).toBe(false);
  });
});
