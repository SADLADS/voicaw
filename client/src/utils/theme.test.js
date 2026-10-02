// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// A stand-in for prefers-color-scheme that tests can flip.
let systemLight = false;
let changeListener = null;
function stubMatchMedia() {
  window.matchMedia = vi.fn(() => ({
    get matches() { return systemLight; },
    addEventListener: (type, listener) => { changeListener = listener; },
  }));
}

async function loadTheme() {
  vi.resetModules();
  return import('./theme.js');
}

beforeEach(() => {
  localStorage.clear();
  systemLight = false;
  changeListener = null;
  stubMatchMedia();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.bsTheme;
});

describe('theme', () => {
  it('is dark by default', async () => {
    const { getThemeChoice, resolveTheme, applyTheme } = await loadTheme();
    expect(getThemeChoice()).toBe('dark');
    expect(resolveTheme()).toBe('dark');
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.bsTheme).toBe('dark');
  });

  it('switches at once and is kept in localStorage only', async () => {
    const { setThemeChoice } = await loadTheme();
    setThemeChoice('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.bsTheme).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
    setThemeChoice('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('theme')).toBeNull();
  });

  it('has Ol’ Familiar: its own colours, dark underneath for Bootstrap', async () => {
    const { setThemeChoice, resolveTheme } = await loadTheme();
    setThemeChoice('familiar');
    expect(resolveTheme()).toBe('familiar');
    expect(document.documentElement.dataset.theme).toBe('familiar');
    expect(document.documentElement.dataset.bsTheme).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('familiar');
    expect((await loadTheme()).getThemeChoice()).toBe('familiar');
  });

  it('reads the saved choice on start, ignoring anything unknown', async () => {
    localStorage.setItem('theme', 'light');
    expect((await loadTheme()).getThemeChoice()).toBe('light');
    localStorage.setItem('theme', 'purple');
    expect((await loadTheme()).getThemeChoice()).toBe('dark');
  });

  it('follows the system live when set to match it', async () => {
    const { setThemeChoice, resolveTheme } = await loadTheme();
    setThemeChoice('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    systemLight = true;
    changeListener();
    expect(resolveTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores system changes when a theme is chosen', async () => {
    const { setThemeChoice } = await loadTheme();
    setThemeChoice('dark');
    systemLight = true;
    changeListener();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('follows a change made in another tab', async () => {
    const { getThemeChoice } = await loadTheme();
    localStorage.setItem('theme', 'light');
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme' }));
    expect(getThemeChoice()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
