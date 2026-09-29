// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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
import { announceProfilePictureChange } from '../utils/profilePicture';

const user = { id: 7, username: 'alice' };

function renderPanel(props = {}, path = '/dm/2') {
  return render(
    <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test' }}>
      <MemoryRouter initialEntries={[path]}>
        <UserPanel user={user} {...props} />
      </MemoryRouter>
    </ConfigContext.Provider>
  );
}

describe('UserPanel', () => {
  it('shows your picture, name and connection, with the settings button', () => {
    const { container } = renderPanel();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(container.querySelector('.user-panel-avatar img')).toHaveAttribute('src', 'https://s3.test/profile-pics/7');
    expect(screen.getByRole('link', { name: 'User settings' })).toHaveAttribute('href', '/settings');
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

  it('falls back to the default picture, and shows a newly uploaded one', () => {
    const { container } = renderPanel();
    const img = () => container.querySelector('.user-panel-avatar img');
    fireEvent.error(img());
    expect(img().getAttribute('src')).not.toContain('s3.test');

    act(() => announceProfilePictureChange());
    expect(img().getAttribute('src')).toMatch(/^https:\/\/s3\.test\/profile-pics\/7\?v=\d+$/);
  });
});
