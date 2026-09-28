// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const statusListeners = [];
vi.mock('../utils/ws-client', () => ({
  onUserStatus: (cb) => {
    statusListeners.push(cb);
    return () => {
      const idx = statusListeners.indexOf(cb);
      if (idx !== -1) statusListeners.splice(idx, 1);
    };
  },
}));

import DmSidebar from './DmSidebar';
import { ConfigContext } from '../App';

function renderSidebar(users, { path = '/dm/2' } = {}) {
  return render(
    <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test' }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/dm/:id" element={<DmSidebar users={users} />} />
        </Routes>
      </MemoryRouter>
    </ConfigContext.Provider>
  );
}

beforeEach(() => {
  statusListeners.length = 0;
});

describe('DmSidebar', () => {
  const users = [
    { id: 1, username: 'alice', online: false },
    { id: 2, username: 'bob', online: true },
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

  it('reflects the initial online prop via the online-dot class', () => {
    renderSidebar(users);

    const aliceDot = screen.getByText('alice').closest('a').querySelector('.online-dot');
    const bobDot = screen.getByText('bob').closest('a').querySelector('.online-dot');

    expect(aliceDot.className).toContain('offline');
    expect(bobDot.className).toContain('online');
  });

  it('updates the online-dot when a user_status event fires', () => {
    renderSidebar(users);

    expect(statusListeners).toHaveLength(1);

    statusListeners[0]({ userId: '1', status: 'online' });

    const aliceDot = screen.getByText('alice').closest('a').querySelector('.online-dot');
    expect(aliceDot.className).toContain('online');
  });

  it('falls back to the default avatar when the profile pic fails to load', () => {
    renderSidebar(users);

    const img = screen.getByAltText('alice');
    img.dispatchEvent(new Event('error'));

    expect(img.src).toContain('default');
  });
});
