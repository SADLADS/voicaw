// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ImageCropper from './ImageCropper';

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:picked');
  globalThis.URL.revokeObjectURL = vi.fn();
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 100 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 100 });
});

function open() {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(<ImageCropper file={new File(['x'], 'a.png', { type: 'image/png' })} onApply={onApply} onCancel={onCancel} />);
  return { onApply, onCancel, frame: screen.getByRole('group') };
}

describe('ImageCropper', () => {
  it('waits for the picture before Apply', () => {
    open();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.load(document.querySelector('.image-cropper-frame img'));
    expect(screen.getByRole('button', { name: 'Apply' })).not.toBeDisabled();
  });

  it('applies the zoomed and moved square', () => {
    const { onApply, frame } = open();
    fireEvent.load(document.querySelector('.image-cropper-frame img'));
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '2' } });
    fireEvent.keyDown(frame, { key: 'ArrowLeft', shiftKey: true }); // shows more of the left
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const crop = onApply.mock.calls[0][0];
    expect(crop.width).toBeCloseTo(0.5);
    expect(crop.height).toBeCloseTo(0.5);
    expect(crop.x).toBeCloseTo(0.2);
    expect(crop.y).toBeCloseTo(0.25);
  });

  it('closes on Escape before anything it opened over sees it', () => {
    const outer = vi.fn();
    window.addEventListener('keydown', (e) => { if (!e.defaultPrevented) outer(); });
    const { onCancel } = open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
