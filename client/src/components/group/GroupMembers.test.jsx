// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/groupKeys', () => ({
  changeMembership: vi.fn(async () => {}),
  renameGroup: vi.fn(async () => {}),
  setGroupPicture: vi.fn(async () => {}),
}));

import GroupMembers from './GroupMembers';

const users = [
  { id: 1, username: 'alice' },
  { id: 2, username: 'bob' },
];
const group = {
  detail: { id: 9, users },
  log: { ownerId: 1, members: new Map([[1, {}], [2, {}]]) },
  name: null,
};

describe('GroupMembers', () => {
  it("opens someone's profile card over the chat, closed by Escape", () => {
    render(<MemoryRouter><GroupMembers group={group} user={{ id: 1 }} users={users} /></MemoryRouter>);
    fireEvent.click(screen.getByText('bob').closest('button'));
    const card = screen.getByRole('dialog', { name: 'bob' });
    expect(card.parentElement).toBe(document.body);
    expect(within(card).getByText('bob')).toBeInTheDocument();
    // Only the profile: no roles here.
    expect(within(card).queryByRole('button')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
