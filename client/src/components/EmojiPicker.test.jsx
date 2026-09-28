// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import data from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';
import EmojiPicker from './EmojiPicker';

let index;
beforeAll(() => { index = buildEmojiIndex(data); });
beforeEach(() => localStorage.clear());

function renderPicker(props = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <EmojiContext.Provider value={index}>
      <div>
        <button type="button">outside</button>
        <EmojiPicker onSelect={onSelect} onClose={onClose} {...props} />
      </div>
    </EmojiContext.Provider>
  );
  return { ...utils, onSelect, onClose };
}

describe('EmojiPicker', () => {
  it('shows emoji by category with Twemoji images', () => {
    renderPicker();
    expect(screen.getByRole('heading', { name: 'Smileys & People' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Flags' })).toBeInTheDocument();
    const grinning = screen.getByRole('button', { name: 'Grinning Face' });
    expect(within(grinning).getByRole('img')).toHaveAttribute('src', '/emoji/1f600.svg');
  });

  it('searches', () => {
    renderPicker();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'pizza' } });
    expect(screen.queryByRole('heading', { name: 'Smileys & People' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pizza' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'zzzzqq' } });
    expect(screen.getByText('No emoji match "zzzzqq"')).toBeInTheDocument();
  });

  it('inserts the emoji and closes; shift+click keeps it open', () => {
    const { onSelect, onClose } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Grinning Face' }), { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith('😀');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Grinning Face' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('applies and remembers the skin tone', () => {
    const { onSelect, unmount } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Skin tone' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Skin tone 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Thumbs Up' }));
    expect(onSelect).toHaveBeenLastCalledWith('👍🏽');
    unmount();

    // (Now also under Frequently Used.)
    const second = renderPicker();
    fireEvent.click(screen.getAllByRole('button', { name: 'Thumbs Up' })[0]);
    expect(second.onSelect).toHaveBeenLastCalledWith('👍🏽');
  });

  it('shows frequently used emoji first', () => {
    const first = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Pizza' }));
    first.unmount();

    renderPicker();
    const frequent = screen.getByRole('heading', { name: 'Frequently Used' }).closest('section');
    expect(within(frequent).getByRole('button', { name: 'Pizza' })).toBeInTheDocument();
  });

  it("shows the hovered emoji's name and shortcode", () => {
    renderPicker();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Thumbs Up' }));
    expect(screen.getByText(':+1:')).toBeInTheDocument();
  });

  it('closes on Escape and on clicking outside', () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
