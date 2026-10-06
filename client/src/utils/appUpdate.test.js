// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// A fresh copy of the module (it keeps state) for each test.
let appUpdate;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  appUpdate = await import('./appUpdate');
});
afterEach(() => vi.useRealTimers());

// The store's current state, as components see it.
function getState() {
  const { result, unmount } = renderHook(() => appUpdate.useAppUpdate());
  const value = result.current;
  unmount();
  return value;
}

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

  it('keeps checking once an update is waiting, so a newer deploy replaces it', async () => {
    const reg = fakeRegistration();
    appUpdate.watchForUpdates(reg);
    appUpdate.setUpdateAvailable(vi.fn());
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it('looks for a newer version before applying, without waiting long', async () => {
    vi.stubGlobal('location', { reload: vi.fn() });
    const reg = fakeRegistration({ finds: true });
    appUpdate.watchForUpdates(reg);
    const apply = vi.fn(async () => {});
    appUpdate.setUpdateAvailable(apply);

    const applying = appUpdate.applyUpdate();
    expect(reg.update).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled(); // the newer one is installing
    await vi.advanceTimersByTimeAsync(20);
    await applying;
    expect(apply).toHaveBeenCalledTimes(1);

    reg.update.mockImplementation(() => new Promise(() => {})); // never answers
    const again = appUpdate.applyUpdate();
    await vi.advanceTimersByTimeAsync(5000);
    await again;
    expect(apply).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("doesn't show a dismissed banner again for the same update", () => {
    appUpdate.setUpdateAvailable(vi.fn(), { reloads: false, version: '1.1.0', size: 10 });
    const { seq } = getState();
    appUpdate.setUpdateAvailable(vi.fn(), { reloads: false, version: '1.1.0', size: 10 });
    expect(getState().seq).toBe(seq);
    appUpdate.setUpdateAvailable(vi.fn(), { reloads: false, version: '1.2.0', size: 10 });
    expect(getState().seq).toBe(seq + 1);
  });

  it('restarts the desktop app onto the newest version, showing a newer download', async () => {
    let ready;
    let progress;
    let finish;
    const app = {
      onUpdateReady: (cb) => { ready = cb; },
      onUpdateProgress: (cb) => { progress = cb; },
      installUpdate: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
    };
    appUpdate.watchDesktopUpdates(app);
    ready('1.1.0');
    expect(getState()).toMatchObject({ available: true, reloads: false, version: '1.1.0' });

    progress(0.5); // a background download: not shown
    expect(getState().progress).toBe(null);

    appUpdate.applyUpdate();
    expect(app.installUpdate).toHaveBeenCalled();
    expect(appUpdate.updateProgressText(getState())).toMatch(/newer version/);
    progress(0.42); // 1.2.0 came out since
    expect(appUpdate.updateProgressText(getState())).toMatch(/42%/);
    ready('1.2.0');
    expect(getState().progress).toBe(0.42);

    finish(false); // the download failed
    await vi.advanceTimersByTimeAsync(0);
    expect(getState()).toMatchObject({ lastLook: false, progress: null, failed: true });
  });

  it('offers a reload when part of the old build is gone from the server', () => {
    appUpdate.watchForStaleApp();
    const event = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
