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
    expect(screen.getByRole('status')).toHaveTextContent('A new version of Voicaw is available.');

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
