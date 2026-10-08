// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STREAM_WINDOW_NAME,
  closeStreamWindow,
  getStreamWindow,
  onStreamWindowChange,
  openStreamWindow,
  setStreamWindowTitle,
} from './streamWindow';

// A stand-in for the window window.open gives (jsdom can't open one).
function fakeWindow() {
  return {
    document: document.implementation.createHTMLDocument(''),
    closed: false,
    focus: vi.fn(),
    close() {
      this.closed = true;
    },
  };
}

describe('the popped-out stream window', () => {
  let popup;

  beforeEach(() => {
    vi.useFakeTimers();
    popup = fakeWindow();
    vi.spyOn(window, 'open').mockImplementation(() => popup);
    document.head.innerHTML = '<style id="a">.x{}</style><link rel="stylesheet" href="/assets/main.css"><script></script>';
    document.documentElement.dataset.theme = 'light';
  });

  afterEach(() => {
    closeStreamWindow();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('opens a named window with the page\'s styles and theme, to draw into', () => {
    expect(openStreamWindow()).toBe(true);
    expect(window.open).toHaveBeenCalledWith('', STREAM_WINDOW_NAME, expect.stringContaining('popup'));
    const doc = popup.document;
    expect(doc.head.querySelector('style').textContent).toBe('.x{}');
    expect(doc.head.querySelector('link[rel=stylesheet]').getAttribute('href')).toBe('/assets/main.css');
    expect(doc.head.querySelector('script')).toBeNull();
    expect(doc.documentElement.dataset.theme).toBe('light');
    expect(getStreamWindow()).toBe(doc.querySelector('.popout-window-root'));
  });

  it('follows theme changes and styles added later', async () => {
    openStreamWindow();
    document.documentElement.dataset.theme = 'dark';
    const added = document.createElement('style');
    added.textContent = '.later{}';
    document.head.appendChild(added);
    await Promise.resolve();
    expect(popup.document.documentElement.dataset.theme).toBe('dark');
    expect([...popup.document.head.querySelectorAll('style')].map((s) => s.textContent)).toContain('.later{}');
  });

  it('says so when the browser blocks it', () => {
    window.open.mockImplementation(() => null);
    expect(openStreamWindow()).toBe(false);
    expect(getStreamWindow()).toBeNull();
  });

  it('brings the open one forward rather than opening another', () => {
    openStreamWindow();
    openStreamWindow();
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalledTimes(2);
  });

  it('notices it being closed, by us or by the person', () => {
    const changes = vi.fn();
    const stop = onStreamWindowChange(changes);
    openStreamWindow();
    closeStreamWindow();
    expect(popup.closed).toBe(true);
    expect(getStreamWindow()).toBeNull();

    popup = fakeWindow();
    openStreamWindow();
    popup.closed = true; // closed with the window's own close button
    vi.advanceTimersByTime(600);
    expect(getStreamWindow()).toBeNull();
    expect(changes).toHaveBeenCalledTimes(4);
    stop();
  });

  it('closes when this page goes, and starts afresh in a window left from before', () => {
    popup.document.body.innerHTML = '<p>old</p>';
    openStreamWindow();
    expect(popup.document.body.querySelector('p')).toBeNull();
    setStreamWindowTitle('Sam\'s screen – Voicaw');
    expect(popup.document.title).toBe('Sam\'s screen – Voicaw');
    window.dispatchEvent(new Event('pagehide'));
    expect(popup.closed).toBe(true);
    expect(getStreamWindow()).toBeNull();
  });
});
