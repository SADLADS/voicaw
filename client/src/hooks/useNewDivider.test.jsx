// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNewDivider } from './useNewDivider';

const msg = (id, sender_id = 2) => ({ id, sender_id });

function setup(initial) {
  return renderHook((props) => useNewDivider(props), {
    initialProps: { chatId: 'a', firstUnread: null, isLoading: true, messages: [], userId: 1, ...initial },
  });
}

describe('useNewDivider', () => {
  // jsdom's document never has the focus: the window counts as in the foreground unless a test says.
  beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(true); });
  afterEach(() => vi.restoreAllMocks());

  it("keeps where the chat's unread started, as opening it said", () => {
    const { result, rerender } = setup();
    const opened = { id: 2 };
    rerender({ chatId: 'a', firstUnread: opened, isLoading: true, messages: [], userId: 1 });
    expect(result.current).toBeNull(); // nothing until the messages are there
    const props = { chatId: 'a', firstUnread: opened, isLoading: false, messages: [msg(1), msg(2), msg(3)], userId: 1 };
    rerender(props);
    expect(result.current).toBe(2);
    // A live message while you're looking doesn't move it.
    rerender({ ...props, messages: [msg(1), msg(2), msg(3), msg(4)] });
    expect(result.current).toBe(2);
  });

  it("starts over in another chat, never taking the last chat's", () => {
    const first = { id: 5 };
    const { result, rerender } = setup({ firstUnread: first, isLoading: false, messages: [msg(4), msg(5)] });
    expect(result.current).toBe(5);
    // The conversation hook still holds the last chat's for a moment.
    rerender({ chatId: 'b', firstUnread: first, isLoading: true, messages: [], userId: 1 });
    rerender({ chatId: 'b', firstUnread: null, isLoading: false, messages: [msg(8)], userId: 1 });
    expect(result.current).toBeNull();
    // Opening it said where (the same id as before still counts: a new answer).
    rerender({ chatId: 'b', firstUnread: { id: 5 }, isLoading: false, messages: [msg(5), msg(8)], userId: 1 });
    expect(result.current).toBe(5);
  });

  it('goes when you send a message', () => {
    const firstUnread = { id: 2 };
    const { result, rerender } = setup({ firstUnread, isLoading: false, messages: [msg(1), msg(2)] });
    expect(result.current).toBe(2);
    rerender({ chatId: 'a', firstUnread, isLoading: false, messages: [msg(1), msg(2), { id: 'pending-1', sender_id: 1 }], userId: 1 });
    expect(result.current).toBe(2);
    rerender({ chatId: 'a', firstUnread, isLoading: false, messages: [msg(1), msg(2), msg(3, 1)], userId: 1 });
    expect(result.current).toBeNull();
  });

  it('moves to the first message that comes while the window is in the background', () => {
    const focused = vi.mocked(document.hasFocus);
    const props = { chatId: 'a', firstUnread: null, isLoading: false, messages: [msg(1)], userId: 1 };
    const { result, rerender } = setup(props);
    expect(result.current).toBeNull();

    focused.mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('blur')); });
    rerender({ ...props, messages: [msg(1), msg(2)] });
    expect(result.current).toBe(2);
    rerender({ ...props, messages: [msg(1), msg(2), msg(3)] });
    expect(result.current).toBe(2);

    // Back, and away again: the next one starts the new messages.
    focused.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('focus')); });
    rerender({ ...props, messages: [msg(1), msg(2), msg(3), msg(4)] });
    expect(result.current).toBe(2);
    focused.mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('blur')); });
    rerender({ ...props, messages: [msg(1), msg(2), msg(3), msg(4), msg(5)] });
    expect(result.current).toBe(5);
  });
});
