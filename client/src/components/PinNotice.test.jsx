// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PinNotice from './PinNotice';
import { mergeProfiles } from '../utils/profiles';

describe('PinNotice', () => {
  const msg = { id: 9, sender_id: 42, sender_username: 'bob', system: 'pin', parent_message_id: 5, timestamp: 1700000000 };

  it('says who pinned a message, jumps to it and opens the pinned list', () => {
    mergeProfiles([{ id: 42, username: 'bob', display_name: 'Bob' }]);
    const onJump = vi.fn();
    const onShowPins = vi.fn();
    const { container } = render(<PinNotice msg={msg} onJump={onJump} onShowPins={onShowPins} />);
    expect(container.firstChild).toHaveTextContent('Bob pinned a message to this chat. See all pinned messages.');
    fireEvent.click(screen.getByRole('button', { name: 'a message' }));
    expect(onJump).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByRole('button', { name: 'See all pinned messages.' }));
    expect(onShowPins).toHaveBeenCalled();
  });

  it('has no buttons where there is nothing to open', () => {
    render(<PinNotice msg={msg} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
