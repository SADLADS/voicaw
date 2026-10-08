// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useSwipeToClose } from './useSwipeToClose';

function Panel({ onClose, enabled = true }) {
  const ref = useRef(null);
  useSwipeToClose(ref, { enabled, onClose });
  return <aside ref={ref} data-testid="panel"><div>member</div></aside>;
}

const at = (x, y = 100) => ({ touches: [{ identifier: 0, clientX: x, clientY: y }] });
const lifted = { touches: [] };

// A finger landing at x = 100 and moving through `xs` (y can drift with `ys`), then lifted.
function swipe(xs, ys = []) {
  const panel = screen.getByTestId('panel');
  const el = screen.getByText('member');
  fireEvent.touchStart(el, at(100));
  xs.forEach((x, i) => fireEvent.touchMove(el, at(x, ys[i] ?? 100)));
  const during = panel.style.transform;
  fireEvent.touchEnd(el, lifted);
  act(() => vi.advanceTimersByTime(250));
  return during;
}

function setup(props) {
  vi.useFakeTimers();
  const onClose = vi.fn();
  render(<Panel onClose={onClose} {...props} />);
  Object.defineProperty(screen.getByTestId('panel'), 'clientWidth', { value: 400 });
  return onClose;
}

afterEach(() => vi.useRealTimers());

describe('useSwipeToClose', () => {
  it('follows a swipe to the right and closes when it goes far enough', () => {
    const onClose = setup();
    const during = swipe([110, 200, 260]);
    expect(during).toBe('translate3d(160px, 0, 0)');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('settles back for a short swipe, a leftward one or scrolling', () => {
    const onClose = setup();
    const panel = screen.getByTestId('panel');
    swipe([110, 150]); // 50px: not far enough
    expect(panel.style.transform).toBe('');
    expect(swipe([90, 20])).toBe(''); // left: nothing
    expect(swipe([105, 120], [130, 300])).toBe(''); // mostly down: scrolling
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does nothing when off', () => {
    const onClose = setup({ enabled: false });
    expect(swipe([110, 300])).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });
});
