// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

import UserPanel from './UserPanel';
import { ConfigContext } from '../contexts';
import { clearProfiles, mergeProfiles, setAvatarBase } from '../utils/profiles';

const user = { id: 7, username: 'alice' };

function renderPanel(props = {}, path = '/dm/2') {
  return render(
    <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test' }}>
      <MemoryRouter initialEntries={[path]}>
        <UserPanel user={user} {...props} />
        <Routes>
          <Route path="/settings/profile" element={<p>Edit Profile page</p>} />
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

    it('goes to Edit Profile and logs out', () => {
      const onLogout = vi.fn();
      renderPanel({ onLogout });
      openMenu();
      fireEvent.click(screen.getByRole('button', { name: 'Edit Profile' }));
      expect(screen.getByText('Edit Profile page')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
      expect(updateProfile).toHaveBeenCalledWith({ customStatus: 'coding' });
      expect(updateProfile).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'coding' })).toBeInTheDocument();

      updateProfile.mockResolvedValueOnce({ id: 7, username: 'alice', custom_status: null });
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear custom status' })));
      expect(updateProfile).toHaveBeenLastCalledWith({ customStatus: null });
      expect(screen.getByRole('button', { name: 'Set a custom status' })).toBeInTheDocument();
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
