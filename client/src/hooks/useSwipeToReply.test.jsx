// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { REPLY_PX, swipeOffset, useSwipeToReply } from './useSwipeToReply';

function List({ onReply, canReply = () => true, enabled = true }) {
  const ref = useRef(null);
  useSwipeToReply(ref, { enabled, canReply, onReply });
  return (
    <div ref={ref}>
      <div data-key="a"><div className="each-dm-message-wrapper">first</div></div>
      <div data-key="b">
        <div className="each-dm-message-wrapper">
          <div className="inline-edit-wrapper">editing</div>
        </div>
      </div>
    </div>
  );
}

const at = (x, y = 100) => ({ touches: [{ identifier: 0, clientX: x, clientY: y }] });
const lifted = { touches: [] };

// A finger landing at x = 300 and moving through `xs` (y can drift with `ys`), then lifted.
function swipe(el, xs, ys = []) {
  fireEvent.touchStart(el, at(300));
  xs.forEach((x, i) => fireEvent.touchMove(el, at(x, ys[i] ?? 100)));
  const row = el.closest('.each-dm-message-wrapper');
  const during = row.style.transform;
  fireEvent.touchEnd(el, lifted);
  return during;
}

describe('useSwipeToReply', () => {
  it('replies to a message swiped far enough left, and springs it back', () => {
    const onReply = vi.fn();
    render(<List onReply={onReply} />);
    const el = screen.getByText('first');

    const during = swipe(el, [290, 260, 200]);
    expect(during).toMatch(/translate3d\(-/);
    expect(onReply).toHaveBeenCalledWith('a');
    expect(el.style.transform).toBe('');
    expect(el.dataset.swipe).toBeUndefined();
  });

  it('does nothing for a short swipe, a rightward one, scrolling or a refused row', () => {
    const onReply = vi.fn();
    const { unmount } = render(<List onReply={onReply} />);
    const el = screen.getByText('first');
    swipe(el, [290, 270]); // 30px left: not far enough
    swipe(el, [310, 400]); // right: the panes' swipe
    swipe(el, [295, 200], [130, 300]); // mostly down: scrolling
    expect(el.style.transform).toBe('');
    unmount();

    render(<List onReply={onReply} canReply={() => false} />);
    swipe(screen.getByText('first'), [290, 100]);
    expect(onReply).not.toHaveBeenCalled();
  });

  it('leaves the inline editor alone, and is off when disabled', () => {
    const onReply = vi.fn();
    const { unmount } = render(<List onReply={onReply} />);
    swipe(screen.getByText('editing'), [290, 100]);
    unmount();
    render(<List onReply={onReply} enabled={false} />);
    swipe(screen.getByText('first'), [290, 100]);
    expect(onReply).not.toHaveBeenCalled();
  });

  it('follows the finger up to the reply point, then resists', () => {
    expect(swipeOffset(20)).toBe(0);
    expect(swipeOffset(-40)).toBe(40);
    expect(swipeOffset(-REPLY_PX)).toBe(REPLY_PX);
    expect(swipeOffset(-REPLY_PX - 100)).toBeCloseTo(REPLY_PX + 30);
  });
});
