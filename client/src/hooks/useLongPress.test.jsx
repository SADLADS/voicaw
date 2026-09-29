// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useLongPress } from './useLongPress';

function Target({ onLongPress, onClick, enabled }) {
  const props = useLongPress(onLongPress, { enabled });
  return <button type="button" onClick={onClick} {...props}>hold me</button>;
}

const touch = (x = 10, y = 10) => ({ touches: [{ clientX: x, clientY: y }] });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useLongPress', () => {
  it('fires after holding still, and swallows the click that ends it', () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    render(<Target onLongPress={onLongPress} onClick={onClick} />);
    const el = screen.getByText('hold me');

    fireEvent.touchStart(el, touch());
    act(() => vi.advanceTimersByTime(449));
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onLongPress).toHaveBeenCalledTimes(1);

    fireEvent.touchEnd(el);
    fireEvent.click(el);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(el); // later taps are normal clicks again
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by lifting early or scrolling', () => {
    const onLongPress = vi.fn();
    render(<Target onLongPress={onLongPress} />);
    const el = screen.getByText('hold me');

    fireEvent.touchStart(el, touch());
    act(() => vi.advanceTimersByTime(200));
    fireEvent.touchEnd(el);
    act(() => vi.advanceTimersByTime(1000));

    fireEvent.touchStart(el, touch(10, 10));
    fireEvent.touchMove(el, touch(10, 40));
    act(() => vi.advanceTimersByTime(1000));
    expect(onLongPress).not.toHaveBeenCalled();

    fireEvent.touchStart(el, touch(10, 10));
    fireEvent.touchMove(el, touch(13, 14)); // a little wobble is fine
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('suppresses the browser menu, and does nothing when disabled', () => {
    const onLongPress = vi.fn();
    const { rerender } = render(<Target onLongPress={onLongPress} />);
    expect(fireEvent.contextMenu(screen.getByText('hold me'))).toBe(false);

    rerender(<Target onLongPress={onLongPress} enabled={false} />);
    fireEvent.touchStart(screen.getByText('hold me'), touch());
    act(() => vi.advanceTimersByTime(1000));
    expect(onLongPress).not.toHaveBeenCalled();
    expect(fireEvent.contextMenu(screen.getByText('hold me'))).toBe(true);
  });
});
