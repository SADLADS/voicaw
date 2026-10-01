// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import data from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';
import EmojiPicker from './EmojiPicker';
import { CustomEmojiContext } from '../emoji/customEmojiContext';
import { ConfigContext } from '../contexts';

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
  it('shows emoji by category from the Twemoji sprite sheets', () => {
    renderPicker();
    expect(screen.getByRole('heading', { name: 'Smileys & People' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Flags' })).toBeInTheDocument();
    const grinning = within(screen.getByRole('button', { name: 'Grinning Face' })).getByRole('img', { name: '😀' });
    expect(grinning).toHaveClass('emoji-sheet-people');
    expect(document.querySelector('.emoji-picker style').textContent).toMatch(/\.emoji-sheet-people\{background-image:url\("\/emoji\/sheets\/[^/]+\/people\.webp"\)/);
    const pizza = within(screen.getByRole('button', { name: 'Pizza' })).getByRole('img');
    expect(pizza).toHaveClass('emoji-sheet-foods');
  });

  it('uses the skin tone sheet for the chosen tone', () => {
    localStorage.setItem('emojiSkinTone', '3');
    renderPicker();
    const thumbs = within(screen.getByRole('button', { name: 'Thumbs Up' })).getByRole('img');
    expect(thumbs).toHaveClass('emoji-sheet-tone3');
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

  it("shows the hovered emoji's :shortcode: (not its full name)", () => {
    const { container } = renderPicker();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Thumbs Up' }));
    const preview = container.querySelector('.emoji-picker-preview');
    expect(preview).toHaveTextContent(':+1:');
    expect(preview).not.toHaveTextContent('Thumbs Up');
  });

  it('closes on Escape and on clicking outside', () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Enter in the search box picks the top result', () => {
    const { onSelect } = renderPicker();
    const search = screen.getByRole('searchbox', { name: 'Search emoji' });
    fireEvent.change(search, { target: { value: 'pizza' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('🍕');
  });
});


describe('EmojiPicker custom emoji', () => {
  const guildOne = { id: 1, name: 'Cool Guild', icon_version: 0 };
  const guildTwo = { id: 2, name: 'Blob Land', icon_version: 0 };
  const blob = { id: 10, name: 'blob', guild: guildTwo };
  const cat = { id: 11, name: 'blobcat', guild: guildTwo };
  const wave = { id: 20, name: 'wave_hi', guild: guildOne };
  // In rail order: Blob Land first.
  const custom = {
    guilds: [{ guild: guildTwo, emojis: [blob, cat] }, { guild: guildOne, emojis: [wave] }],
    byId: new Map([['10', blob], ['11', cat], ['20', wave]]),
  };

  function renderWithCustom() {
    const onSelect = vi.fn();
    render(
      <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test' }}>
        <CustomEmojiContext.Provider value={custom}>
          <EmojiContext.Provider value={index}>
            <EmojiPicker onSelect={onSelect} onClose={vi.fn()} />
          </EmojiContext.Provider>
        </CustomEmojiContext.Provider>
      </ConfigContext.Provider>
    );
    return { onSelect };
  }

  it("puts each guild's emoji after Frequently Used and before the standard ones, in rail order", () => {
    localStorage.setItem('emojiFrequent', JSON.stringify({ grinning: 3, 'custom:20': 5 }));
    renderWithCustom();
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings.slice(0, 4)).toEqual(['Frequently Used', 'Blob Land', 'Cool Guild', 'Smileys & People']);
    // Frequently used mixes custom and standard emoji.
    const frequent = screen.getByRole('heading', { name: 'Frequently Used' }).closest('section');
    expect(within(frequent).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([':wave_hi:', 'Grinning Face']);
    // The category bar shows the guild's icon (initials here).
    const nav = screen.getByRole('navigation', { name: 'Emoji categories' });
    expect(within(nav).getByRole('button', { name: 'Blob Land' })).toHaveTextContent('BL');
  });

  it('picks a custom emoji as <:name:id> and remembers it', () => {
    const { onSelect } = renderWithCustom();
    const button = screen.getByRole('button', { name: ':blob:' });
    expect(within(button).getByRole('img')).toHaveAttribute('src', 'https://s3.test/emojis/10');
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith('<:blob:10>');
    expect(JSON.parse(localStorage.getItem('emojiFrequent'))).toEqual({ 'custom:10': 1 });
  });

  it('finds custom emoji first when searching', () => {
    renderWithCustom();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'wave' } });
    const buttons = screen.getAllByRole('button', { name: /wave/i });
    expect(buttons[0]).toHaveAttribute('aria-label', ':wave_hi:');
    expect(buttons.length).toBeGreaterThan(1);
  });
});
