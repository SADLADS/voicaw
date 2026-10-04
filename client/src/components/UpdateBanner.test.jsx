// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

let appUpdate;
let UpdateBanner;
let AppUpdateSettings;
beforeEach(async () => {
  vi.resetModules();
  appUpdate = await import('../utils/appUpdate');
  ({ default: UpdateBanner } = await import('./UpdateBanner'));
  ({ default: AppUpdateSettings } = await import('./AppUpdateSettings'));
});

describe('UpdateBanner', () => {
  it('appears when an update is ready and applies it', () => {
    render(<UpdateBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    const apply = vi.fn(async () => {});
    act(() => appUpdate.setUpdateAvailable(apply));
    expect(screen.getByRole('status')).toHaveTextContent('Update availableA new version is ready.');

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(apply).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  });

  it('can be dismissed until the next update', () => {
    render(<UpdateBanner />);
    act(() => appUpdate.setUpdateAvailable(vi.fn()));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => appUpdate.setUpdateAvailable(vi.fn()));
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('AppUpdateSettings', () => {
  it('checks for updates on request', async () => {
    const reg = { installing: null, waiting: null, update: vi.fn(async () => {}) };
    appUpdate.watchForUpdates(reg);
    render(<AppUpdateSettings />);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check for updates' })));
    expect(reg.update).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent("You're on the latest version.");
  });

  it('offers to update once one is ready', () => {
    const apply = vi.fn(async () => {});
    render(<AppUpdateSettings />);
    act(() => appUpdate.setUpdateAvailable(apply));

    expect(screen.getByRole('status')).toHaveTextContent('A new version is ready.');
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(apply).toHaveBeenCalled();
  });
});

// A stand-in for the Android app's plugin (VoicawPlugin checkForUpdate / installUpdate).
function fakeAndroid(info, install = async () => {}) {
  const listeners = {};
  return {
    listeners,
    checkForUpdate: vi.fn(async () => info),
    installUpdate: vi.fn(install),
    addListener: (event, fn) => { listeners[event] = fn; },
  };
}

describe('the Android app updating itself', () => {
  const newer = { supported: true, current: '0.1.4', available: true, version: '0.1.5', size: 25 * 1024 * 1024 };

  it('offers a newer version, downloads it on Update, then waits for Android', async () => {
    let finish;
    const app = fakeAndroid(newer, () => new Promise((resolve) => { finish = resolve; }));
    render(<UpdateBanner />);
    await act(async () => appUpdate.watchAndroidUpdates(app));
    expect(screen.getByRole('status')).toHaveTextContent('Voicaw 0.1.5 · 25 MB');
    expect(app.installUpdate).not.toHaveBeenCalled(); // nothing downloads by itself

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(app.installUpdate).toHaveBeenCalledTimes(1);
    act(() => app.listeners.updateProgress({ received: 10, total: 40 }));
    expect(screen.getByRole('status')).toHaveTextContent('Downloading… 25%');
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();

    await act(async () => finish());
    expect(screen.getByRole('status')).toHaveTextContent('Install it when Android asks.');
  });

  it('offers it again when Android was told no, and says when the download failed', async () => {
    const app = fakeAndroid(newer);
    render(<UpdateBanner />);
    await act(async () => appUpdate.watchAndroidUpdates(app));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })));
    act(() => app.listeners.updateResult({ status: 'aborted' }));
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Voicaw 0.1.5');

    app.installUpdate.mockRejectedValueOnce(new Error('offline'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })));
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't download the update.");
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
  });

  it('shows the installed version, and that Google Play updates its build', async () => {
    const app = fakeAndroid({ supported: false, current: '0.1.4' });
    render(<AppUpdateSettings />);
    await act(async () => appUpdate.watchAndroidUpdates(app));
    expect(screen.getByText('Android app 0.1.4')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check for updates' })));
    expect(screen.getByRole('status')).toHaveTextContent('Google Play keeps this app up to date.');
  });

  it("doesn't offer anything when it's up to date", async () => {
    const app = fakeAndroid({ supported: true, current: '0.1.5', available: false, version: '0.1.5', size: 1 });
    render(<UpdateBanner />);
    expect(await act(async () => {
      appUpdate.watchAndroidUpdates(app);
      return appUpdate.checkForUpdates();
    })).toBe('current');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
