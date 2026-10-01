// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import data from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';

// jsdom has no IntersectionObserver; stub one (before the picker module loads) that records
// what it watches, so the test decides which emoji count as near the visible area.
const observers = [];
class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    observers.push(this);
  }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
  reveal(el) { this.callback([{ target: el, isIntersecting: true }]); }
}

let EmojiPicker;
let index;
beforeAll(async () => {
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  ({ default: EmojiPicker } = await import('./EmojiPicker'));
  index = buildEmojiIndex(data);
});
afterAll(() => vi.unstubAllGlobals());

describe('EmojiPicker image loading', () => {
  it('only loads emoji images once they come near the visible area', () => {
    render(
      <EmojiContext.Provider value={index}>
        <EmojiPicker onSelect={() => {}} onClose={() => {}} />
      </EmojiContext.Provider>
    );
    const observer = observers.at(-1);
    expect(observer.options.root).toHaveClass('emoji-picker-scroll');

    const grinning = within(screen.getByRole('button', { name: 'Grinning Face' })).getByRole('img');
    const pizza = within(screen.getByRole('button', { name: 'Pizza' })).getByRole('img');
    expect(grinning).not.toHaveAttribute('src');
    expect(pizza).not.toHaveAttribute('src');
    expect(observer.targets.has(grinning)).toBe(true);

    act(() => observer.reveal(grinning));
    expect(grinning).toHaveAttribute('src', '/emoji/1f600.svg');
    expect(pizza).not.toHaveAttribute('src');
    expect(observer.targets.has(grinning)).toBe(false);
  });
});
