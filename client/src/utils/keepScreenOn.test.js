import { describe, it, expect, vi, afterEach } from 'vitest';

const plugin = { keepScreenOn: vi.fn(async () => {}) };
let inApp = false;
vi.mock('./android', () => ({
  get android() {
    return inApp ? plugin : null;
  },
}));

import { keepScreenOn } from './keepScreenOn';

afterEach(() => {
  inApp = false;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('keepScreenOn', () => {
  it("holds the browser's screen wake lock until let go", async () => {
    const lock = { release: vi.fn(async () => {}) };
    const request = vi.fn(async () => lock);
    vi.stubGlobal('navigator', { wakeLock: { request } });
    const letGo = keepScreenOn();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith('screen');
    letGo();
    expect(lock.release).toHaveBeenCalled();
  });

  it('lets go of a lock granted after it was no longer wanted, and does without one', async () => {
    const lock = { release: vi.fn(async () => {}) };
    let grant;
    vi.stubGlobal('navigator', { wakeLock: { request: () => new Promise((resolve) => { grant = resolve; }) } });
    const letGo = keepScreenOn();
    letGo();
    grant(lock);
    await vi.waitFor(() => expect(lock.release).toHaveBeenCalled());

    vi.stubGlobal('navigator', {});
    expect(() => keepScreenOn()()).not.toThrow();
  });

  it("uses the Android app's own flag", () => {
    inApp = true;
    const letGo = keepScreenOn();
    expect(plugin.keepScreenOn).toHaveBeenLastCalledWith({ on: true });
    letGo();
    expect(plugin.keepScreenOn).toHaveBeenLastCalledWith({ on: false });
  });
});
