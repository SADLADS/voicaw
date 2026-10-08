// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { cornerFor, useCornerDrag } from './useCornerDrag';

function Players({ onClick }) {
  const pip = useCornerDrag('bottom-right');
  return (
    <div ref={pip.ref} data-testid="box" className={`at-${pip.corner}${pip.dragging ? ' dragging' : ''}`} onPointerDown={pip.onPointerDown}>
      <div className="stream-view corner" data-testid="handle">
        <button type="button" onClick={onClick}>Stop watching</button>
      </div>
    </div>
  );
}

// jsdom lays nothing out: the box is 320×180 wherever its style puts it, else bottom right.
function place(box) {
  box.getBoundingClientRect = () => {
    const left = box.style.left ? parseFloat(box.style.left) : window.innerWidth - 336;
    const top = box.style.top ? parseFloat(box.style.top) : window.innerHeight - 196;
    return { left, top, width: 320, height: 180, right: left + 320, bottom: top + 180 };
  };
}

const pointer = (type, target, x, y) => fireEvent[type](target, { clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('cornerFor', () => {
  it('picks the corner nearest the middle of the box', () => {
    expect(cornerFor({ left: 10, top: 10, width: 100, height: 50 }, 1000, 800)).toBe('top-left');
    expect(cornerFor({ left: 800, top: 10, width: 100, height: 50 }, 1000, 800)).toBe('top-right');
    expect(cornerFor({ left: 10, top: 700, width: 100, height: 50 }, 1000, 800)).toBe('bottom-left');
    expect(cornerFor({ left: 460, top: 380, width: 100, height: 50 }, 1000, 800)).toBe('bottom-right');
  });
});

describe('dragging the corner players', () => {
  it('follows the pointer, snaps to the nearest corner and keeps it', async () => {
    window.innerWidth = 1200;
    window.innerHeight = 800;
    render(<Players />);
    const box = screen.getByTestId('box');
    place(box);
    const handle = screen.getByTestId('handle');
    pointer('pointerDown', handle, 1000, 700);
    pointer('pointerMove', box, 600, 400);
    expect(box.className).toContain('dragging');
    pointer('pointerMove', box, 100, 100);
    expect(box.style.left).toBe('0px'); // kept on the screen
    pointer('pointerUp', box, 100, 100);
    expect(box.className).toBe('at-top-left');
    expect(box.style.left).toBe('');
    expect(localStorage.getItem('pipCorner')).toBe('top-left');
    // The click ending a drag is swallowed only until the browser's next task.
    await new Promise((resolve) => setTimeout(resolve, 0));

    cleanup();
    render(<Players />);
    expect(screen.getByTestId('box').className).toBe('at-top-left');
  });

  it('leaves clicks alone: a small move, or on a button', () => {
    const onClick = vi.fn();
    render(<Players onClick={onClick} />);
    const box = screen.getByTestId('box');
    place(box);
    pointer('pointerDown', screen.getByTestId('handle'), 1000, 700);
    pointer('pointerMove', box, 1003, 702);
    pointer('pointerUp', box, 1003, 702);
    expect(box.className).toBe('at-bottom-right');

    const button = screen.getByRole('button');
    pointer('pointerDown', button, 1000, 700);
    pointer('pointerMove', box, 100, 100);
    pointer('pointerUp', box, 100, 100);
    expect(box.className).toBe('at-bottom-right');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
