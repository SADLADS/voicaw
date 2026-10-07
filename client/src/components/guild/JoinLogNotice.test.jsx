// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import JoinLogNotice from './JoinLogNotice';
import { mergeProfiles } from '../../utils/profiles';

describe('JoinLogNotice', () => {
  it('says who joined or left, and their name opens their profile card', () => {
    mergeProfiles([{ id: 41, username: 'alice', display_name: 'Alice' }]);
    const onOpenProfile = vi.fn();
    const { container, rerender } = render(
      <JoinLogNotice msg={{ id: 1, sender_id: 41, sender_username: 'alice', system: 'member_join', timestamp: 1700000000 }} onOpenProfile={onOpenProfile} />
    );
    expect(container.firstChild).toHaveTextContent('Alice joined the guild.');
    expect(container.firstChild).not.toHaveClass('left');
    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    expect(onOpenProfile).toHaveBeenCalledWith({ id: 41, username: 'alice' }, expect.anything());

    rerender(<JoinLogNotice msg={{ id: 2, sender_id: 41, sender_username: 'alice', system: 'member_leave', timestamp: 1700000000 }} />);
    expect(container.firstChild).toHaveTextContent('Alice left the guild.');
    expect(container.firstChild).toHaveClass('left');
  });
});
