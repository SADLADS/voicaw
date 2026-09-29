// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { applyPresenceSnapshot, applyUserStatus, resetPresence } from '../utils/presence';
import DmSidebar from './DmSidebar';
import { ConfigContext } from '../contexts';

function renderSidebar(users, { path = '/dm/2', unreadDms } = {}) {
  return render(
    <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test' }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/dm/:id" element={<DmSidebar users={users} unreadDms={unreadDms} />} />
        </Routes>
      </MemoryRouter>
    </ConfigContext.Provider>
  );
}

beforeEach(() => {
  resetPresence();
});

describe('DmSidebar', () => {
  const users = [
    { id: 1, username: 'alice', status: 'offline', last_online: null },
    { id: 2, username: 'bob', status: 'online' },
  ];

  it('renders one link per user with their username', () => {
    renderSidebar(users);

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('marks the conversation matching the current route as active', () => {
    renderSidebar(users, { path: '/dm/2' });

    const bobLink = screen.getByText('bob').closest('a');
    const aliceLink = screen.getByText('alice').closest('a');

    expect(bobLink.className).toContain('active');
    expect(aliceLink.className).not.toContain('active');
  });

  const dotOf = (name) => screen.getByText(name).closest('a').querySelector('.online-dot');

  it('shows the status the API gave until the live one arrives', () => {
    renderSidebar(users);

    expect(dotOf('alice')).toHaveClass('offline');
    expect(dotOf('bob')).toHaveClass('online');
  });

  it('follows the live snapshot and status changes, with last seen for offline people', () => {
    renderSidebar(users);

    act(() => applyPresenceSnapshot({ 1: 'mobile' }));
    expect(dotOf('alice')).toHaveClass('mobile');
    expect(dotOf('alice')).toHaveAttribute('title', 'Online on mobile');
    expect(dotOf('bob')).toHaveClass('offline');

    act(() => applyUserStatus({ userId: 1, status: 'idle' }));
    expect(dotOf('alice')).toHaveClass('idle');

    act(() => applyUserStatus({ userId: 1, status: 'offline', lastOnline: Math.floor(Date.now() / 1000) - 3 * 3600 }));
    expect(dotOf('alice')).toHaveClass('offline');
    expect(dotOf('alice')).toHaveAttribute('title', 'Last seen 3 hours ago');
  });

  it('falls back to the default avatar when the profile pic fails to load', () => {
    renderSidebar(users);

    const img = screen.getByAltText('alice');
    img.dispatchEvent(new Event('error'));

    expect(img.src).toContain('default');
  });

  it('marks conversations with unread messages, except the open one', () => {
    renderSidebar(
      [...users, { id: 3, username: 'carol', status: 'offline' }],
      { unreadDms: [{ from_user_id: 1, count: 2 }, { from_user_id: 2, count: 1 }] }
    );
    const dot = (name) => screen.getByText(name).closest('a').querySelector('.userdot');
    expect(dot('alice')).toHaveClass('active');
    expect(dot('bob')).not.toHaveClass('active'); // open (/dm/2)
    expect(dot('carol')).not.toHaveClass('active');
  });
});
