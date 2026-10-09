// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import emojiData from '@emoji-mart/data/sets/15/twitter.json';
import MessageReactions from './MessageReactions';
import { InteractionContext } from '../contexts';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';

const index = buildEmojiIndex(emojiData);
const names = { 1: 'alice', 2: 'bob', 3: 'carol', 4: 'dave', 5: 'erin', 6: 'frank' };

const react = (emoji, ...userIds) => userIds.map((id) => ({ id: `${emoji}${id}`, user_id: id, emoji }));

function renderReactions(props = {}, { isMobile = false, onRowTouch } = {}) {
  const onToggle = vi.fn();
  const utils = render(
    <InteractionContext.Provider value={{ isMobile }}>
      <EmojiContext.Provider value={index}>
        <div onTouchStart={onRowTouch}>
          <MessageReactions
            reactions={[...react('👍', 2, 3, 4, 5, 6), ...react('😂', 1, 2)]}
            userId={1}
            names={names}
            onToggle={onToggle}
            onAdd={vi.fn()}
            {...props}
          />
        </div>
      </EmojiContext.Provider>
    </InteractionContext.Provider>
  );
  return { ...utils, onToggle };
}

// (jsdom's selectors can't match an emoji in an attribute.)
const chip = (emoji) => [...document.querySelectorAll('[data-reaction]')].find((el) => el.dataset.reaction === emoji);
const hover = (el) => {
  fireEvent.pointerOver(el, { pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(300); });
};
const card = () => document.querySelector('.reaction-card');

afterEach(() => {
  vi.useRealTimers();
});

describe('MessageReactions', () => {
  it('hovering a chip shows who reacted, naming three and counting the rest', () => {
    vi.useFakeTimers();
    renderReactions();
    hover(chip('👍'));
    expect(card()).toHaveTextContent(':+1: reacted by bob, carol, dave and 2 others');
  });

  it('names everyone when there are three or fewer, and hides the card after leaving', () => {
    vi.useFakeTimers();
    renderReactions();
    hover(chip('😂'));
    expect(card()).toHaveTextContent(':joy: reacted by alice and bob');
    fireEvent.pointerOut(chip('😂'), { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(200); });
    expect(card()).toBeNull();
  });

  it("doesn't show the card for touches", () => {
    vi.useFakeTimers();
    renderReactions();
    fireEvent.pointerOver(chip('👍'), { pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(300); });
    expect(card()).toBeNull();
  });

  it('clicking the card opens every reaction, by emoji, and takes your own back', () => {
    vi.useFakeTimers();
    const { onToggle } = renderReactions();
    hover(chip('👍'));
    fireEvent.click(card());

    const dialog = screen.getByRole('dialog', { name: 'Reactions' });
    expect(within(dialog).getByRole('tab', { name: ':+1:: 5 reactions' })).toHaveAttribute('aria-selected', 'true');
    const list = within(dialog).getByRole('tabpanel');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['bob', 'carol', 'dave', 'erin', 'frank']);
    expect(within(list).queryByRole('button', { name: 'Remove your reaction' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('tab', { name: ':joy:: 2 reactions' }));
    const joy = within(dialog).getByRole('tabpanel');
    expect(within(joy).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['alice (you)×', 'bob']);
    fireEvent.click(within(joy).getByRole('button', { name: 'Remove your reaction' }));
    expect(onToggle).toHaveBeenCalledWith('😂');
  });

  it("someone else's chip can't be tapped without permission to react, but still shows who reacted", () => {
    vi.useFakeTimers();
    const { onToggle } = renderReactions({ onAdd: undefined });
    fireEvent.click(chip('👍'));
    expect(onToggle).not.toHaveBeenCalled();
    expect(chip('👍')).toHaveAttribute('aria-disabled', 'true');
    hover(chip('👍'));
    expect(card()).not.toBeNull();
    fireEvent.click(chip('😂'));
    expect(onToggle).toHaveBeenCalledWith('😂');
  });

  it('on a phone, holding a chip opens the breakdown instead of the message actions', () => {
    vi.useFakeTimers();
    const onRowTouch = vi.fn();
    const { onToggle } = renderReactions({}, { isMobile: true, onRowTouch });
    const target = chip('😂');
    fireEvent.touchStart(target, { touches: [{ clientX: 5, clientY: 5 }] });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.touchEnd(target);
    fireEvent.click(target); // the tap that ends the hold
    expect(onRowTouch).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: ':joy:: 2 reactions' })).toHaveAttribute('aria-selected', 'true');
  });

  it('the breakdown closes itself when the last reaction goes', () => {
    vi.useFakeTimers();
    const { rerender } = renderReactions({ reactions: react('😂', 1) });
    hover(chip('😂'));
    fireEvent.click(card());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(
      <InteractionContext.Provider value={{ isMobile: false }}>
        <EmojiContext.Provider value={index}>
          <MessageReactions reactions={[]} userId={1} names={names} onToggle={vi.fn()} onAdd={vi.fn()} />
        </EmojiContext.Provider>
      </InteractionContext.Provider>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
