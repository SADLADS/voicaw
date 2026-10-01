// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import data from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';
import { CustomEmojiContext } from '../emoji/customEmojiContext';
import { ConfigContext } from '../contexts';

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
  it('only loads custom emoji images once they come near the visible area', () => {
    const guild = { id: 1, name: 'Blob Land', icon_version: 0 };
    const blob = { id: 10, name: 'blob', guild };
    const cat = { id: 11, name: 'blobcat', guild };
    const custom = { guilds: [{ guild, emojis: [blob, cat] }], byId: new Map([['10', blob], ['11', cat]]) };
    render(
      <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test' }}>
        <CustomEmojiContext.Provider value={custom}>
          <EmojiContext.Provider value={index}>
            <EmojiPicker onSelect={() => {}} onClose={() => {}} />
          </EmojiContext.Provider>
        </CustomEmojiContext.Provider>
      </ConfigContext.Provider>
    );
    const observer = observers.at(-1);
    expect(observer.options.root).toHaveClass('emoji-picker-scroll');

    const blobImage = within(screen.getByRole('button', { name: ':blob:' })).getByRole('img');
    const catImage = within(screen.getByRole('button', { name: ':blobcat:' })).getByRole('img');
    expect(blobImage).not.toHaveAttribute('src');
    expect(catImage).not.toHaveAttribute('src');
    expect(observer.targets.has(blobImage)).toBe(true);

    act(() => observer.reveal(blobImage));
    expect(blobImage).toHaveAttribute('src', 'https://s3.test/emojis/10');
    expect(catImage).not.toHaveAttribute('src');
    expect(observer.targets.has(blobImage)).toBe(false);

    // Standard emoji come from the sprite sheets, which load with the picker.
    const grinning = within(screen.getByRole('button', { name: 'Grinning Face' })).getByRole('img');
    expect(grinning).toHaveClass('emoji-sheet-people');
    expect(observer.targets.has(grinning)).toBe(false);
  });
});
