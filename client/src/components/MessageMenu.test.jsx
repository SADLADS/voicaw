// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import data from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';
import MessageMenu from './MessageMenu';

const index = buildEmojiIndex(data);
const anchor = { left: 100, right: 100, top: 50, bottom: 50 };
beforeEach(() => localStorage.clear());

function renderMenu(props = {}) {
  const handlers = {
    onReact: vi.fn(), onMoreReactions: vi.fn(), onReply: vi.fn(), onEdit: vi.fn(), onTogglePin: vi.fn(),
    onCopy: vi.fn(async () => {}), onDelete: vi.fn(), onClose: vi.fn(),
  };
  render(
    <EmojiContext.Provider value={index}>
      <MessageMenu msg={{ id: 1, plaintext: 'hello' }} isOwn myReactions={new Set()} anchor={anchor} {...handlers} {...props} />
    </EmojiContext.Provider>
  );
  return handlers;
}

const itemNames = () => screen.getAllByRole('menuitem').map((b) => b.textContent.trim());

describe('MessageMenu', () => {
  it('offers everything for your own message', () => {
    renderMenu();
    expect(itemNames()).toEqual(['Add Reaction', 'Reply', 'Edit Message', 'Pin Message', 'Copy Text', 'Delete Message']);
  });

  it("leaves out editing and deleting someone else's message, and pinning when you can't", () => {
    renderMenu({ isOwn: false, onTogglePin: undefined });
    expect(itemNames()).toEqual(['Add Reaction', 'Reply', 'Copy Text']);
  });

  it("lets a moderator delete anyone's message, and says Unpin for a pinned one", () => {
    renderMenu({ isOwn: false, canDelete: true, msg: { id: 1, plaintext: 'hi', pinned_at: 5 } });
    expect(itemNames()).toEqual(['Add Reaction', 'Reply', 'Unpin Message', 'Copy Text', 'Delete Message']);
  });

  it('only offers copying for a message still sending', () => {
    renderMenu({ msg: { id: 'temp-1', plaintext: 'hi', status: 'pending' } });
    expect(screen.queryByRole('group', { name: 'React' })).not.toBeInTheDocument();
    expect(itemNames()).toEqual(['Copy Text']);
  });

  it("doesn't offer reacting where you can't", () => {
    renderMenu({ canReact: false });
    expect(screen.queryByRole('group', { name: 'React' })).not.toBeInTheDocument();
    expect(itemNames()).not.toContain('Add Reaction');
  });

  it('offers View Reactions once the message has some, even to those who can\'t react', () => {
    const onViewReactions = vi.fn();
    const msg = { id: 1, plaintext: 'hi', reactions: [{ id: 'r1', user_id: 2, emoji: '👍' }] };
    renderMenu({ msg, onViewReactions });
    expect(itemNames()).toEqual(['Add Reaction', 'View Reactions', 'Reply', 'Edit Message', 'Pin Message', 'Copy Text', 'Delete Message']);
    fireEvent.click(screen.getByRole('menuitem', { name: /View Reactions/ }));
    expect(onViewReactions).toHaveBeenCalled();
  });

  it('has no View Reactions without reactions (poll votes not counting) or without a handler', () => {
    renderMenu({ msg: { id: 1, plaintext: 'hi', reactions: [{ id: 'r1', user_id: 2, emoji: 'poll:abcd1234' }] }, onViewReactions: vi.fn() });
    expect(itemNames()).not.toContain('View Reactions');
  });

  it('still offers View Reactions without Add Reactions', () => {
    renderMenu({ canReact: false, isOwn: false, onTogglePin: undefined, msg: { id: 1, plaintext: 'hi', reactions: [{ id: 'r1', user_id: 2, emoji: '👍' }] }, onViewReactions: vi.fn() });
    expect(itemNames()).toEqual(['View Reactions', 'Reply', 'Copy Text']);
  });

  it('reacts in one click from the quick reactions, marking your own', () => {
    const { onReact, onClose } = renderMenu({ myReactions: new Set(['❤️']) });
    const row = screen.getByRole('group', { name: 'React' });
    expect(within(row).getAllByRole('menuitemcheckbox')).toHaveLength(5);
    expect(within(row).getByRole('menuitemcheckbox', { name: 'React with Red Heart' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(row).getByRole('menuitemcheckbox', { name: 'React with Thumbs Up' }));
    expect(onReact).toHaveBeenCalledWith('👍');
    expect(onClose).toHaveBeenCalled();
  });

  it('runs the picked action and closes; Add Reaction opens the picker where it was clicked', async () => {
    const { onReply, onMoreReactions, onClose } = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onReply).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add Reaction' }));
    await waitFor(() => expect(onMoreReactions).toHaveBeenCalledWith(anchor));
  });

  it('passes the click to Delete (Shift skips the question)', async () => {
    const { onDelete } = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Message' }), { shiftKey: true });
    await waitFor(() => expect(onDelete).toHaveBeenCalled());
    expect(onDelete.mock.calls[0][0].shiftKey).toBe(true);
  });

  it('closes as soon as the text is copied, saying nothing', async () => {
    const { onClose } = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Text' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('shows a failed copy in the menu', async () => {
    const { onClose } = renderMenu({ onCopy: vi.fn(async () => { throw new Error('No clipboard'); }) });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Text' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No clipboard');
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lists a guild bot's message commands under Apps, and runs the one picked", async () => {
    const onRunApp = vi.fn();
    const apps = [{ id: 3, type: 3, name: 'Quote', bot: { id: 9, name: 'Quote Bot' } }];
    const { onClose } = renderMenu({ apps, onRunApp });
    fireEvent.click(screen.getByRole('menuitem', { name: /Apps/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Quote/ }));
    expect(onRunApp).toHaveBeenCalledWith(apps[0]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('has no Apps without message commands', () => {
    renderMenu();
    expect(screen.queryByRole('menuitem', { name: /Apps/ })).toBeNull();
  });
});
