// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const updateProfile = vi.hoisted(() => vi.fn());
vi.mock('../services/profileService', () => ({ updateProfile }));

const connection = vi.hoisted(() => ({ state: 'online', listeners: new Set() }));
vi.mock('../utils/ws-client', () => ({
  getConnectionState: () => connection.state,
  onConnectionState: (cb) => {
    connection.listeners.add(cb);
    return () => connection.listeners.delete(cb);
  },
}));

// The picker itself is tested in EmojiPicker.test.jsx: here it picks a rabbit.
vi.mock('./EmojiPicker', () => ({
  default: ({ onSelect, onClose }) => <button type="button" onClick={() => { onSelect('🐇'); onClose(); }}>Pick a rabbit</button>,
}));

import { onOpenUserProfile } from '../utils/userProfile';
import UserPanel from './UserPanel';
import { applyAdminAlerts } from '../utils/adminAlerts';
import { ConfigContext } from '../contexts';
import { clearProfiles, mergeProfiles, setAvatarBase } from '../utils/profiles';

const user = { id: 7, username: 'alice' };

function renderPanel(props = {}, path = '/dm/2') {
  return render(
    <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test' }}>
      <MemoryRouter initialEntries={[path]}>
        <UserPanel user={user} {...props} />
        <Routes>
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </ConfigContext.Provider>
  );
}

describe('UserPanel', () => {
  it('shows your picture, name and connection, with the settings button', () => {
    setAvatarBase('https://s3.test');
    mergeProfiles([{ id: 7, username: 'alice', avatar: 'abc' }]);
    const { container } = renderPanel();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(container.querySelector('.user-panel-avatar img')).toHaveAttribute('src', 'https://s3.test/profile-pics/7/abc.webp');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it("counts what's waiting for an admin on the gear, until it's dealt with", () => {
    renderPanel();
    expect(document.querySelector('.user-panel-alerts')).toBeNull();
    act(() => applyAdminAlerts({ reports: 1, signups: 2, testers: 0 }));
    expect(screen.getByRole('link', { name: 'Settings (3 waiting for you)' })).toHaveAttribute('href', '/settings');
    expect(document.querySelector('.user-panel-alerts')).toHaveTextContent('3');
    act(() => applyAdminAlerts({ reports: 0, signups: 0, testers: 0 }));
    expect(document.querySelector('.user-panel-alerts')).toBeNull();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('follows the connection state', () => {
    renderPanel();
    act(() => {
      connection.state = 'connecting';
      connection.listeners.forEach((cb) => cb('connecting'));
    });
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Connecting…' })).toHaveClass('connecting');
    connection.state = 'online';
  });

  it('shows your custom status under your name while connected, the connection otherwise', () => {
    clearProfiles();
    mergeProfiles([{ id: 7, username: 'alice', custom_status: 'Out for lunch', custom_status_emoji: '🐇' }]);
    const { container } = renderPanel();
    const line = () => container.querySelector('.user-panel-state');
    expect(line()).toHaveTextContent('🐇Out for lunch');
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Online' })).toBeInTheDocument(); // the dot still says it
    act(() => {
      connection.state = 'connecting';
      connection.listeners.forEach((cb) => cb('connecting'));
    });
    expect(line()).toHaveTextContent('Connecting…');
    act(() => {
      connection.state = 'online';
      connection.listeners.forEach((cb) => cb('online'));
    });
    // Only an emoji is a status too.
    act(() => mergeProfiles([{ id: 7, username: 'alice', custom_status: null }]));
    expect(line()).toHaveTextContent('🐇');
    act(() => mergeProfiles([{ id: 7, username: 'alice', custom_status_emoji: null }]));
    expect(line()).toHaveTextContent('Online');
  });

  it('shows the default picture without one (or if it fails), and a new one as soon as it changes', () => {
    setAvatarBase('https://s3.test');
    clearProfiles();
    const { container } = renderPanel();
    const img = () => container.querySelector('.user-panel-avatar img');
    expect(img().getAttribute('src')).not.toContain('s3.test');

    act(() => mergeProfiles([{ id: 7, username: 'alice', avatar: 'first' }]));
    expect(img()).toHaveAttribute('src', 'https://s3.test/profile-pics/7/first.webp');
    fireEvent.error(img());
    expect(img().getAttribute('src')).not.toContain('s3.test');
    // A new picture has a new URL, which is tried again.
    act(() => mergeProfiles([{ id: 7, username: 'alice', avatar: 'second' }]));
    expect(img()).toHaveAttribute('src', 'https://s3.test/profile-pics/7/second.webp');
  });

  describe('menu', () => {
    const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /Online/ }));

    it('opens from your picture and name, and closes on a second click, Escape or outside', () => {
      clearProfiles();
      mergeProfiles([{ id: 7, username: 'alice', display_name: 'Alice A', custom_status: 'busy' }]);
      renderPanel();
      openMenu();
      const menu = screen.getByRole('dialog', { name: 'Your account' });
      expect(menu).toHaveTextContent('Alice A');
      expect(menu).toHaveTextContent('busy');
      openMenu();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      openMenu();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      openMenu();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('opens your full profile (Edit Profile, your picture, your name) and logs out', () => {
      const onLogout = vi.fn();
      const opened = vi.fn();
      const stop = onOpenUserProfile(opened);
      renderPanel({ onLogout });
      openMenu();
      fireEvent.click(screen.getByRole('button', { name: 'Edit Profile' }));
      expect(opened).toHaveBeenLastCalledWith(7);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      openMenu();
      fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
      expect(opened).toHaveBeenCalledTimes(2);
      openMenu();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'alice' }));
      expect(opened).toHaveBeenCalledTimes(3);
      stop();
      openMenu();
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      expect(onLogout).toHaveBeenCalled();
    });

    it('copies your user id and closes', () => {
      const writeText = vi.fn().mockResolvedValue();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderPanel();
      openMenu();
      fireEvent.click(screen.getByRole('button', { name: 'Copy User ID' }));
      expect(writeText).toHaveBeenCalledWith('7');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('gives no right-click menu on the panel or the menu', () => {
      renderPanel();
      const me = screen.getByRole('button', { name: /Online/ });
      expect(fireEvent.contextMenu(me.querySelector('img'))).toBe(false);
      openMenu();
      const menu = screen.getByRole('dialog', { name: 'Your account' });
      expect(fireEvent.contextMenu(menu.querySelector('img'))).toBe(false);
    });

    it('sets and clears your custom status', async () => {
      clearProfiles();
      mergeProfiles([{ id: 7, username: 'alice' }]);
      updateProfile.mockResolvedValueOnce({ id: 7, username: 'alice', custom_status: 'coding' });
      renderPanel();
      openMenu();
      fireEvent.click(screen.getByRole('button', { name: 'Set a custom status' }));
      const input = screen.getByRole('textbox', { name: 'Custom status' });
      fireEvent.change(input, { target: { value: '  coding ' } });
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
      expect(updateProfile).toHaveBeenCalledWith({ customStatus: 'coding', customStatusEmoji: null });
      expect(updateProfile).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'coding' })).toBeInTheDocument();

      updateProfile.mockResolvedValueOnce({ id: 7, username: 'alice', custom_status: null });
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear custom status' })));
      expect(updateProfile).toHaveBeenLastCalledWith({ customStatus: null, customStatusEmoji: null });
      expect(screen.getByRole('button', { name: 'Set a custom status' })).toBeInTheDocument();
    });

    it('adds an emoji to your custom status, saved with its text', async () => {
      clearProfiles();
      mergeProfiles([{ id: 7, username: 'alice', custom_status: 'late' }]);
      updateProfile.mockReset();
      updateProfile.mockResolvedValueOnce({ id: 7, username: 'alice', custom_status: 'late', custom_status_emoji: '🐇' });
      renderPanel();
      openMenu();
      fireEvent.click(screen.getByRole('button', { name: 'late' }));
      const input = screen.getByRole('textbox', { name: 'Custom status' });
      // Going to the emoji button (and its picker) isn't leaving the edit.
      const emojiButton = screen.getByRole('button', { name: 'Add an emoji' });
      fireEvent.blur(input, { relatedTarget: emojiButton });
      fireEvent.click(emojiButton);
      fireEvent.click(screen.getByRole('button', { name: 'Pick a rabbit' }));
      expect(updateProfile).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change the emoji' })).toHaveTextContent('🐇');

      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
      expect(updateProfile).toHaveBeenCalledWith({ customStatus: 'late', customStatusEmoji: '🐇' });
      expect(screen.getByRole('button', { name: 'late' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change the emoji' })).toHaveTextContent('🐇');
    });

    it('shows the emoji button without editing: one click opens the picker, the pick saves at once', async () => {
      clearProfiles();
      mergeProfiles([{ id: 7, username: 'alice', custom_status: 'late' }]);
      updateProfile.mockReset();
      updateProfile.mockResolvedValueOnce({ id: 7, username: 'alice', custom_status: 'late', custom_status_emoji: '🐇' });
      renderPanel();
      openMenu();
      expect(screen.queryByRole('textbox', { name: 'Custom status' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Add an emoji' }));
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pick a rabbit' })));
      expect(updateProfile).toHaveBeenCalledWith({ customStatus: 'late', customStatusEmoji: '🐇' });
      expect(screen.getByRole('button', { name: 'Change the emoji' })).toHaveTextContent('🐇');
      // No ✕ beside the emoji outside editing: the status's own ✕ clears both.
      expect(screen.queryByRole('button', { name: 'Remove the emoji' })).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Custom status' })).not.toBeInTheDocument();
    });

    it('removes the emoji alone, keeping the text', async () => {
      clearProfiles();
      mergeProfiles([{ id: 7, username: 'alice', custom_status: 'late', custom_status_emoji: '🐇' }]);
      updateProfile.mockReset();
      updateProfile.mockResolvedValueOnce({ id: 7, username: 'alice', custom_status: 'late', custom_status_emoji: null });
      renderPanel();
      openMenu();
      fireEvent.click(screen.getByRole('button', { name: 'late' }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove the emoji' }));
      await act(async () => fireEvent.keyDown(screen.getByRole('textbox', { name: 'Custom status' }), { key: 'Enter' }));
      expect(updateProfile).toHaveBeenCalledWith({ customStatus: 'late', customStatusEmoji: null });
    });

    it('keeps the status when editing is cancelled with Escape (and the menu open)', () => {
      clearProfiles();
      mergeProfiles([{ id: 7, username: 'alice', custom_status: 'busy' }]);
      updateProfile.mockClear();
      renderPanel();
      openMenu();
      fireEvent.click(screen.getByRole('button', { name: 'busy' }));
      const input = screen.getByRole('textbox', { name: 'Custom status' });
      fireEvent.change(input, { target: { value: 'other' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'busy' })).toBeInTheDocument();
      expect(updateProfile).not.toHaveBeenCalled();
    });
  });
});
