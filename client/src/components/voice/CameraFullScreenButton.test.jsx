// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import CameraFullScreenButton from './CameraFullScreenButton';
import { fullScreenCamera } from '../../voice/fullScreen';

let shown = null;
Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => shown });

afterEach(() => {
  cleanup();
  shown = null;
  delete document.exitFullscreen;
});

function tile(onTileClick = () => {}) {
  render(
    <div className="camera-tile" data-testid="tile" onClick={onTileClick}>
      <CameraFullScreenButton name="alice" />
    </div>,
  );
  const element = screen.getByTestId('tile');
  element.requestFullscreen = vi.fn(() => {
    shown = element;
    return Promise.resolve();
  });
  return element;
}

describe('CameraFullScreenButton', () => {
  it('puts the camera’s tile in full screen, without opening the tile’s volume menu', () => {
    const onTileClick = vi.fn();
    const element = tile(onTileClick);
    fireEvent.click(screen.getByRole('button', { name: "Full screen (alice's camera)" }));
    expect(element.requestFullscreen).toHaveBeenCalled();
    expect(onTileClick).not.toHaveBeenCalled();
  });

  it('offers to leave full screen while it’s in it, and leaves it', () => {
    tile();
    fireEvent.click(screen.getByRole('button', { name: "Full screen (alice's camera)" }));
    act(() => document.dispatchEvent(new Event('fullscreenchange')));
    const exit = screen.getByRole('button', { name: 'Exit full screen' });
    document.exitFullscreen = vi.fn(() => {
      shown = null;
      return Promise.resolve();
    });
    fireEvent.click(exit);
    expect(document.exitFullscreen).toHaveBeenCalled();
    act(() => document.dispatchEvent(new Event('fullscreenchange')));
    expect(screen.getByRole('button', { name: "Full screen (alice's camera)" })).toBeTruthy();
  });
});

describe('fullScreenCamera (a double click on the tile)', () => {
  it('closes the volume menu its clicks opened and goes full screen', () => {
    const element = tile();
    const close = vi.fn();
    fullScreenCamera({ target: element, currentTarget: element, preventDefault() {} }, close);
    expect(close).toHaveBeenCalled();
    expect(element.requestFullscreen).toHaveBeenCalled();
  });

  it('ignores double clicks on the tile’s buttons', () => {
    const element = tile();
    const button = screen.getByRole('button');
    fullScreenCamera({ target: button, currentTarget: element, preventDefault() {} }, () => {});
    expect(element.requestFullscreen).not.toHaveBeenCalled();
  });
});
