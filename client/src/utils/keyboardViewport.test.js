// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { keyboardInset, keyboardOpen, resetKeyboardViewport, watchKeyboardViewport } from './keyboardViewport';

let listeners;
const fire = () => listeners.forEach(({ fn }) => fn());
const appHeight = () => document.documentElement.style.getPropertyValue('--vc-app-height');
const appTop = () => document.documentElement.style.getPropertyValue('--vc-app-top');

beforeEach(() => {
  resetKeyboardViewport();
  listeners = [];
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  window.scrollTo = vi.fn();
  window.visualViewport = {
    width: 400,
    height: 800,
    offsetTop: 0,
    scale: 1,
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => { listeners = listeners.filter((l) => l.fn !== fn || l.type !== type); },
  };
});

afterEach(() => {
  document.documentElement.style.removeProperty('--vc-app-height');
  document.documentElement.style.removeProperty('--vc-app-top');
});

describe('keyboardViewport', () => {
  it('iOS: sizes the app to the part above the keyboard, and back', () => {
    const stop = watchKeyboardViewport();
    expect(appHeight()).toBe('');
    window.visualViewport.height = 470; // keyboard over the page; innerHeight stays 800
    fire();
    expect(keyboardInset()).toBe(330);
    expect(appHeight()).toBe('470px');
    window.visualViewport.height = 800;
    fire();
    expect(appHeight()).toBe('');
    stop();
    expect(listeners).toHaveLength(0);
  });

  it('iOS: follows the page sliding while the keyboard is open, never scrolling it back', () => {
    watchKeyboardViewport();
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 40 });
    fire();
    expect(appTop()).toBe(''); // no keyboard: not ours
    window.visualViewport.height = 470;
    window.visualViewport.offsetTop = 330; // slid up to show the message box
    window.visualViewport.pageTop = 330;
    fire();
    expect(appHeight()).toBe('470px');
    expect(appTop()).toBe('330px');
    // Scrolling back made iOS slide again to keep the caret in view, every frame (the screen
    // shaking while typing): the page is left where the browser put it.
    expect(window.scrollTo).not.toHaveBeenCalled();
    window.visualViewport.offsetTop = 120; // the user drags it back up a little
    window.visualViewport.pageTop = 120;
    fire();
    expect(appTop()).toBe('120px');
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('iOS: without pageTop, follows the scroll plus the offset', () => {
    watchKeyboardViewport();
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 30 });
    window.visualViewport.height = 470;
    window.visualViewport.offsetTop = 300;
    fire();
    expect(appTop()).toBe('330px');
  });

  it('iOS: the app goes back to the top once the keyboard closes, and when stopped', () => {
    const stop = watchKeyboardViewport();
    window.visualViewport.height = 470;
    window.visualViewport.offsetTop = 330;
    window.visualViewport.pageTop = 330;
    fire();
    expect(appTop()).toBe('330px');
    window.visualViewport.height = 800; // keyboard closed
    window.visualViewport.offsetTop = 0;
    window.visualViewport.pageTop = 0;
    fire();
    expect(appTop()).toBe('');
    window.visualViewport.height = 470;
    window.visualViewport.offsetTop = 330;
    window.visualViewport.pageTop = 330;
    fire();
    stop();
    expect(appTop()).toBe('');
    expect(appHeight()).toBe('');
  });

  it('Android (resizes-content): sees the keyboard though the window shrinks with it', () => {
    watchKeyboardViewport();
    window.visualViewport.height = 480;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 480 });
    fire();
    expect(keyboardOpen()).toBe(true);
    expect(appHeight()).toBe('480px');
  });

  it("never takes a height taller than the screen as keyboard-free (Chrome's first 980px layout)", () => {
    Object.defineProperty(window.screen, 'height', { configurable: true, value: 850 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1996 });
    keyboardInset();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    expect(keyboardOpen()).toBe(false);
    delete window.screen.height;
  });

  it('ignores toolbars, pinch zoom, and starts over on rotation', () => {
    watchKeyboardViewport();
    window.visualViewport.height = 740; // address bar
    fire();
    expect(keyboardOpen()).toBe(false);
    window.visualViewport.height = 400;
    window.visualViewport.scale = 2;
    fire();
    expect(keyboardOpen()).toBe(false);
    window.visualViewport.scale = 1;
    window.visualViewport.width = 800; // landscape: a shorter screen, no keyboard
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
    fire();
    expect(keyboardOpen()).toBe(false);
    expect(appHeight()).toBe('');
  });
});
