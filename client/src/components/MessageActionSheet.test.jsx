// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import data from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';
import MessageActionSheet from './MessageActionSheet';

const index = buildEmojiIndex(data);
beforeEach(() => localStorage.clear());

// A tap on the sheet: pointer down, then click (a click alone is the long press's release).
function tap(el) {
  fireEvent.pointerDown(el);
  fireEvent.click(el);
}

function renderSheet(props = {}) {
  const handlers = {
    onReact: vi.fn(), onMoreReactions: vi.fn(), onReply: vi.fn(), onEdit: vi.fn(),
    onCopy: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(),
  };
  render(
    <EmojiContext.Provider value={index}>
      <MessageActionSheet
        msg={{ id: 1, plaintext: 'hello' }}
        isOwn
        myReactions={new Set()}
        {...handlers}
        {...props}
      />
    </EmojiContext.Provider>
  );
  return handlers;
}

describe('MessageActionSheet', () => {
  it('offers quick reactions, your most used first', () => {
    localStorage.setItem('emojiFrequent', JSON.stringify({ tada: 5 }));
    const { onReact, onClose } = renderSheet({ myReactions: new Set(['❤️']) });
    const row = screen.getByRole('group', { name: 'React' });
    const labels = within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).toHaveLength(7);
    expect(labels[0]).toBe('React with Party Popper');
    expect(labels.at(-1)).toBe('More reactions');
    expect(within(row).getByRole('button', { name: 'React with Red Heart' })).toHaveAttribute('aria-pressed', 'true');

    tap(within(row).getByRole('button', { name: 'React with Thumbs Up' }));
    expect(onReact).toHaveBeenCalledWith('👍');
    expect(onClose).toHaveBeenCalled();
  });

  it('offers reply, edit, copy and delete for your own message; delete asks first', () => {
    const { onReply, onDelete, onClose } = renderSheet();
    tap(screen.getByRole('button', { name: 'Reply' }));
    expect(onReply).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeInTheDocument();

    onClose.mockClear();
    tap(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this message? This can't be undone.")).toBeInTheDocument();
    tap(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalled();
  });

  it("leaves out edit and delete on someone else's message", () => {
    renderSheet({ isOwn: false });
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('only offers copying for a message still sending', () => {
    renderSheet({ msg: { id: 'temp-1', plaintext: 'hi', status: 'pending' } });
    expect(screen.queryByRole('group', { name: 'React' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent.trim())).toEqual(['Copy text']);
  });

  it('closes on the backdrop, not on the sheet', () => {
    const { onClose } = renderSheet();
    tap(screen.getByRole('dialog', { name: 'Message actions' }));
    expect(onClose).not.toHaveBeenCalled();
    tap(screen.getByRole('dialog').parentElement);
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores the click from lifting the finger that opened it", () => {
    const { onDelete, onClose, onReact } = renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'React with Thumbs Up' }));
    fireEvent.click(screen.getByRole('dialog').parentElement);
    expect(onReact).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("lists a guild bot's message commands under Apps", () => {
    const onRunApp = vi.fn();
    const apps = [{ id: 3, type: 3, name: 'Quote', bot: { id: 9, name: 'Quote Bot' } }];
    const { onClose } = renderSheet({ apps, onRunApp });
    const group = screen.getByRole('group', { name: 'Apps' });
    tap(within(group).getByRole('button', { name: /Quote/ }));
    expect(onRunApp).toHaveBeenCalledWith(apps[0]);
    expect(onClose).toHaveBeenCalled();
  });
});
