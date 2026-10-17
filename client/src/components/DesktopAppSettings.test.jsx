// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// The desktop app's bridge (electron/preload.js), before anything reads it.
const bridge = vi.hoisted(() => {
  const listeners = {};
  const state = {
    settings: { closeToTray: true, startAtLogin: false, shortcuts: { toggleMute: null, toggleDeafen: null } },
  };
  const api = {
    platform: 'linux',
    state,
    listeners,
    getSettings: vi.fn(async () => state.settings),
    updateSettings: vi.fn(async (changes) => {
      state.settings = { ...state.settings, ...changes, shortcuts: { ...state.settings.shortcuts, ...changes.shortcuts } };
      return { settings: state.settings, failedShortcuts: changes.shortcuts?.toggleDeafen ? ['toggleDeafen'] : [] };
    }),
    notify: vi.fn(),
    setUnread: vi.fn(),
    onNavigate: (cb) => { listeners.navigate = cb; return () => {}; },
    onShortcut: (cb) => { listeners.shortcut = cb; return () => {}; },
  };
  globalThis.window.voicawDesktop = api;
  return api;
});

import DesktopAppSettings from './DesktopAppSettings';

beforeEach(() => {
  bridge.state.settings = { closeToTray: true, startAtLogin: false, shortcuts: { toggleMute: null, toggleDeafen: null } };
  bridge.updateSettings.mockClear();
});

describe('DesktopAppSettings', () => {
  it('shows and changes the app settings', async () => {
    render(<DesktopAppSettings />);
    const tray = await screen.findByLabelText(/Keep running in the tray/);
    expect(tray.checked).toBe(true);
    fireEvent.click(screen.getByLabelText(/Start Voicaw when you log in/));
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ startAtLogin: true }));
    expect(screen.getByLabelText(/Start Voicaw when you log in/).checked).toBe(true);
  });

  it('turns automatic updates off', async () => {
    render(<DesktopAppSettings />);
    const auto = await screen.findByLabelText('Update automatically');
    expect(auto.checked).toBe(true);
    fireEvent.click(auto);
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ autoUpdate: false }));
    expect(screen.getByLabelText('Update automatically').checked).toBe(false);
  });

  it('records a shortcut from the next key press with a modifier', async () => {
    render(<DesktopAppSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle mute shortcut' }));
    expect(screen.getByRole('button', { name: 'Toggle mute shortcut' }).textContent).toBe('Press a key…');
    // A plain key doesn't count; with Ctrl+Shift it does.
    fireEvent.keyDown(window, { key: 'm', code: 'KeyM' });
    expect(bridge.updateSettings).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ shortcuts: { toggleMute: 'Control+Shift+M' } }));
    expect(screen.getByRole('button', { name: 'Toggle mute shortcut' }).textContent).toBe('Ctrl + Shift + M');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenLastCalledWith({ shortcuts: { toggleMute: null } }));
  });

  it('says when another app has the key, and Escape cancels recording', async () => {
    render(<DesktopAppSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle deafen shortcut' }));
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(screen.getByRole('button', { name: 'Toggle deafen shortcut' }).textContent).toBe('Not set');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle deafen shortcut' }));
    await act(async () => {
      fireEvent.keyDown(window, { key: 'D', code: 'KeyD', ctrlKey: true, altKey: true });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Another app is using this shortcut.');
  });
});
