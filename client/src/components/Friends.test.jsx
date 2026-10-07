// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('../utils/api', () => ({ default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

import api from '../utils/api';
import Friends from './Friends';
import { applyFriends } from '../utils/friends';
import { resetPresence } from '../utils/presence';
import { ConfigContext, InteractionContext, LayoutContext } from '../contexts';

const users = [
  { id: 1, username: 'alice', status: 'online' },
  { id: 2, username: 'bob', status: 'offline' },
  { id: 3, username: 'cal', status: 'online' },
  { id: 4, username: 'dee', status: 'offline' },
];

function Where() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderFriends() {
  return render(
    <ConfigContext.Provider value={{}}>
      <InteractionContext.Provider value={{ isMobile: false }}>
        <LayoutContext.Provider value={{ users }}>
          <MemoryRouter initialEntries={['/dm/friends']}>
            <Where />
            <Routes>
              <Route path="/dm/friends" element={<Friends />} />
              <Route path="/dm/:id" element={null} />
            </Routes>
          </MemoryRouter>
        </LayoutContext.Provider>
      </InteractionContext.Provider>
    </ConfigContext.Provider>
  );
}

const lists = (more = {}) => ({ friends: [{ id: 1 }, { id: 2 }], incoming: [], outgoing: [], admin: false, ...more });

beforeEach(() => {
  vi.clearAllMocks();
  resetPresence();
  applyFriends(lists());
});

describe('Friends', () => {
  it('shows online friends, then all of them; a row opens the DM', () => {
    renderFriends();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.queryByText('bob')).not.toBeInTheDocument();
    expect(screen.queryByText('cal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('All friends — 2')).toBeInTheDocument();

    fireEvent.click(screen.getByText('bob'));
    expect(screen.getByTestId('location')).toHaveTextContent('/dm/2');
  });

  it('opens on Pending when someone asked, and accepts or declines', async () => {
    applyFriends(lists({ incoming: [{ id: 3 }], outgoing: [{ id: 4 }] }));
    renderFriends();
    expect(screen.getByRole('tab', { name: /Pending/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Sent you a friend request')).toBeInTheDocument();
    expect(screen.getByText('Friend request sent')).toBeInTheDocument();

    api.put.mockResolvedValue({ data: { ...lists({ friends: [{ id: 1 }, { id: 2 }, { id: 3 }], outgoing: [{ id: 4 }] }), result: 'accepted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.queryByText('Sent you a friend request')).not.toBeInTheDocument());
    expect(api.put).toHaveBeenCalledWith('/friends/3');

    api.delete.mockResolvedValue({ data: { ...lists({ friends: [{ id: 1 }, { id: 2 }, { id: 3 }] }), result: 'removed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(screen.getByText('No friend requests.')).toBeInTheDocument());
    expect(api.delete).toHaveBeenCalledWith('/friends/4');
  });

  it('sends a request by username and says what happened', async () => {
    renderFriends();
    fireEvent.click(screen.getByRole('tab', { name: 'Add friend' }));
    const box = screen.getByLabelText('Username');

    api.post.mockResolvedValue({ data: { ...lists({ outgoing: [{ id: 4 }] }), result: 'requested' } });
    fireEvent.change(box, { target: { value: 'dee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send friend request' }));
    expect(await screen.findByText('Friend request sent to dee.')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/friends', { username: 'dee' });

    api.post.mockRejectedValue({ response: { data: { code: 'not_found' } } });
    fireEvent.change(box, { target: { value: 'nobody' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send friend request' }));
    expect(await screen.findByText('Nobody has that username.')).toBeInTheDocument();
  });

  it('lists everyone for admins only', () => {
    const { unmount } = renderFriends();
    expect(screen.queryByRole('tab', { name: 'Everyone' })).not.toBeInTheDocument();
    unmount();

    act(() => applyFriends(lists({ admin: true })));
    renderFriends();
    fireEvent.click(screen.getByRole('tab', { name: 'Everyone' }));
    for (const name of ['alice', 'bob', 'cal', 'dee']) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add friend' })).toHaveLength(2);
  });
});
