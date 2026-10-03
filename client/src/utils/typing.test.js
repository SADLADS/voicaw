import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyTyping, clearTyping, resetTyping, typingIn, TYPING_MS } from './typing';

describe('typing store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTyping();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps who is typing per chat, in the order they started', () => {
    applyTyping({ chatId: 'group-a', userId: 2 });
    applyTyping({ chatId: 'group-a', userId: 3 });
    applyTyping({ chatId: 'group-a', userId: 2 });
    applyTyping({ chatId: '7', userId: 7 });
    expect(typingIn('group-a')).toEqual([2, 3]);
    expect(typingIn(7)).toEqual([7]);
    expect(typingIn('channel-1')).toEqual([]);
    // The same array until something changes (useSyncExternalStore needs that).
    expect(typingIn('group-a')).toBe(typingIn('group-a'));
  });

  it('forgets someone after a while, unless they keep typing', () => {
    applyTyping({ chatId: 'channel-1', userId: 2 });
    applyTyping({ chatId: 'channel-1', userId: 3 });
    vi.advanceTimersByTime(TYPING_MS - 1000);
    applyTyping({ chatId: 'channel-1', userId: 3 });
    vi.advanceTimersByTime(1000);
    expect(typingIn('channel-1')).toEqual([3]);
    vi.advanceTimersByTime(TYPING_MS);
    expect(typingIn('channel-1')).toEqual([]);
  });

  it('forgets someone whose message arrived', () => {
    applyTyping({ chatId: 'channel-1', userId: 2 });
    clearTyping('channel-1', 2);
    clearTyping('channel-1', 5);
    expect(typingIn('channel-1')).toEqual([]);
  });
});
