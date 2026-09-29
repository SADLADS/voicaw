// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A fresh copy of the module (it keeps state) for each test.
let appUpdate;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  appUpdate = await import('./appUpdate');
});
afterEach(() => vi.useRealTimers());

function fakeRegistration({ finds = false } = {}) {
  const reg = {
    installing: null,
    waiting: null,
    update: vi.fn(async () => {
      if (!finds) return;
      const worker = new EventTarget();
      worker.state = 'installing';
      reg.installing = worker;
      setTimeout(() => {
        worker.state = 'installed';
        reg.installing = null;
        reg.waiting = worker;
        worker.dispatchEvent(new Event('statechange'));
      }, 10);
    }),
  };
  return reg;
}

describe('appUpdate', () => {
  it('reports no service worker as unsupported', async () => {
    expect(await appUpdate.checkForUpdates()).toBe('unsupported');
  });

  it('checks the registration and reports whether a new version was found', async () => {
    appUpdate.watchForUpdates(fakeRegistration());
    expect(await appUpdate.checkForUpdates()).toBe('current');

    appUpdate.watchForUpdates(fakeRegistration({ finds: true }));
    const result = appUpdate.checkForUpdates();
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBe('available');
  });

  it('checks again periodically and when the app comes back into view (not too often)', async () => {
    const reg = fakeRegistration();
    appUpdate.watchForUpdates(reg);

    document.dispatchEvent(new Event('visibilitychange'));
    expect(reg.update).not.toHaveBeenCalled(); // just registered

    await vi.advanceTimersByTimeAsync(61 * 1000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reg.update).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(reg.update).toHaveBeenCalledTimes(2);
  });

  it('applies an available update, reloading if the switch-over does not', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const apply = vi.fn(async () => {});
    appUpdate.setUpdateAvailable(apply);

    await appUpdate.applyUpdate();
    expect(apply).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('offers a reload when part of the old build is gone from the server', () => {
    appUpdate.watchForStaleApp();
    const event = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
