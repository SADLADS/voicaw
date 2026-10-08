// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPopoutWindow } from './popoutWindow';

describe('a pop-out window on a page of ours', () => {
  let popup;
  let win;

  beforeEach(() => {
    vi.useFakeTimers();
    // window.open gives a window still on its first blank document, its page loading.
    popup = {
      document: document.implementation.createHTMLDocument(''),
      closed: false,
      focus: vi.fn(),
      close() {
        this.closed = true;
      },
    };
    vi.spyOn(window, 'open').mockImplementation(() => popup);
    document.head.innerHTML = '<style>.x{}</style>';
    win = createPopoutWindow({ name: 'voicaw-test', url: '/popout.html', title: () => 'Test – Voicaw' });
  });

  afterEach(() => {
    win.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('opens the page, and draws into it only once it has loaded', () => {
    const changes = vi.fn();
    win.subscribe(changes);
    expect(win.open()).toBe(true);
    expect(window.open).toHaveBeenCalledWith('/popout.html', 'voicaw-test', expect.stringContaining('popup'));
    vi.advanceTimersByTime(200);
    expect(win.get()).toBeNull();

    const page = document.implementation.createHTMLDocument('');
    Object.defineProperty(page, 'readyState', { value: 'loading', configurable: true });
    popup.document = page;
    vi.advanceTimersByTime(200);
    expect(win.get()).toBeNull();

    Object.defineProperty(page, 'readyState', { value: 'complete' });
    vi.advanceTimersByTime(100);
    expect(win.get()).toBe(page.querySelector('.popout-window-root'));
    expect(page.title).toBe('Test – Voicaw');
    expect(page.head.querySelector('style').textContent).toBe('.x{}');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting when it\'s closed first', () => {
    win.open();
    win.close();
    popup.document = document.implementation.createHTMLDocument('');
    vi.advanceTimersByTime(200);
    expect(win.get()).toBeNull();
  });
});
