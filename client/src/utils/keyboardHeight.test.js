// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getKeyboardHeight, watchKeyboardHeight } from './keyboardHeight';
import { resetKeyboardViewport } from './keyboardViewport';

let listeners;
beforeEach(() => {
  localStorage.clear();
  resetKeyboardViewport();
  listeners = [];
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  window.visualViewport = {
    width: 400,
    height: 800,
    scale: 1,
    addEventListener: (_, fn) => listeners.push(fn),
    removeEventListener: (_, fn) => { listeners = listeners.filter((l) => l !== fn); },
  };
});

describe('keyboard height', () => {
  it('falls back to ~40% of the screen before the keyboard has been seen', () => {
    expect(getKeyboardHeight()).toBe(320);
  });

  it('remembers the keyboard height when the keyboard opens', () => {
    const stop = watchKeyboardHeight();
    window.visualViewport.height = 470; // keyboard is 330px
    listeners.forEach((fn) => fn());
    stop();

    expect(getKeyboardHeight()).toBe(330);
    expect(listeners).toHaveLength(0);
  });

  it('measures it when the page shrinks too (Android Chrome, resizes-content)', () => {
    const stop = watchKeyboardHeight();
    listeners.forEach((fn) => fn()); // seen without the keyboard first
    window.visualViewport.height = 420;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 420 });
    listeners.forEach((fn) => fn());
    stop();
    // Asked while the page is still short (the keyboard closing as the panel opens).
    expect(getKeyboardHeight()).toBe(380);
  });

  it('ignores small viewport changes (address bar, not a keyboard)', () => {
    watchKeyboardHeight();
    window.visualViewport.height = 740;
    listeners.forEach((fn) => fn());
    expect(getKeyboardHeight()).toBe(320);
  });
});
