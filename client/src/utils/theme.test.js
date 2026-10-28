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

  it('has Halloween: its own colours, dark underneath for Bootstrap', async () => {
    const { setThemeChoice, resolveTheme } = await loadTheme();
    setThemeChoice('halloween');
    expect(resolveTheme()).toBe('halloween');
    expect(document.documentElement.dataset.theme).toBe('halloween');
    expect(document.documentElement.dataset.bsTheme).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('halloween');
    expect((await loadTheme()).getThemeChoice()).toBe('halloween');
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

  it('has Christmas: its own colours, dark underneath for Bootstrap', async () => {
    const { setThemeChoice, resolveTheme } = await loadTheme();
    setThemeChoice('christmas');
    expect(resolveTheme()).toBe('christmas');
    expect(document.documentElement.dataset.bsTheme).toBe('dark');
    expect((await loadTheme()).getThemeChoice()).toBe('christmas');
  });
});

describe('seasonal themes', () => {
  const day = (y, m, d) => new Date(y, m - 1, d, 12);

  it('switches to Christmas in December and back on 1 January', async () => {
    const { setThemeChoice, checkSeason, getThemeChoice } = await loadTheme();
    setThemeChoice('light');
    checkSeason(day(2026, 11, 30));
    expect(getThemeChoice()).toBe('light');
    checkSeason(day(2026, 12, 1));
    expect(getThemeChoice()).toBe('christmas');
    expect(document.documentElement.dataset.theme).toBe('christmas');
    checkSeason(day(2026, 12, 24));
    expect(getThemeChoice()).toBe('christmas');
    checkSeason(day(2027, 1, 1));
    expect(getThemeChoice()).toBe('light');
  });

  it('switches when the app is first opened later in the month, and survives a restart', async () => {
    const { checkSeason } = await loadTheme();
    checkSeason(day(2026, 12, 15));
    const again = await loadTheme();
    expect(again.getThemeChoice()).toBe('christmas');
    again.checkSeason(day(2027, 1, 3));
    expect(again.getThemeChoice()).toBe('dark');
  });

  it('keeps a theme chosen after the switch, and doesn’t switch again that month', async () => {
    const { setThemeChoice, checkSeason, getThemeChoice } = await loadTheme();
    checkSeason(day(2026, 12, 1));
    setThemeChoice('familiar');
    checkSeason(day(2026, 12, 2));
    expect(getThemeChoice()).toBe('familiar');
    checkSeason(day(2027, 1, 1));
    expect(getThemeChoice()).toBe('familiar');
  });

  it('keeps Christmas after the month if it was chosen again by hand', async () => {
    const { setThemeChoice, checkSeason, getThemeChoice } = await loadTheme();
    checkSeason(day(2026, 12, 1));
    setThemeChoice('dark');
    setThemeChoice('christmas');
    checkSeason(day(2027, 1, 1));
    expect(getThemeChoice()).toBe('christmas');
  });

  it('leaves a theme already chosen for the season alone afterwards', async () => {
    const { setThemeChoice, checkSeason, getThemeChoice } = await loadTheme();
    setThemeChoice('halloween');
    checkSeason(day(2026, 10, 5));
    checkSeason(day(2026, 11, 1));
    expect(getThemeChoice()).toBe('halloween');
  });

  it('does Halloween in October, and comes back each year', async () => {
    const { setThemeChoice, checkSeason, getThemeChoice } = await loadTheme();
    setThemeChoice('system');
    checkSeason(day(2026, 10, 1));
    expect(getThemeChoice()).toBe('halloween');
    checkSeason(day(2026, 11, 1));
    expect(getThemeChoice()).toBe('system');
    checkSeason(day(2027, 10, 20));
    expect(getThemeChoice()).toBe('halloween');
  });

  it('goes from Halloween straight to Christmas when November was skipped', async () => {
    const { setThemeChoice, checkSeason, getThemeChoice } = await loadTheme();
    setThemeChoice('light');
    checkSeason(day(2026, 10, 1));
    checkSeason(day(2026, 12, 3));
    expect(getThemeChoice()).toBe('christmas');
    checkSeason(day(2027, 1, 1));
    expect(getThemeChoice()).toBe('light');
  });

  it('can be turned off: nothing switches, and turning off puts the usual theme back', async () => {
    const { setThemeChoice, checkSeason, getThemeChoice, setSeasonalThemes, getSeasonalThemes } = await loadTheme();
    setThemeChoice('light');
    checkSeason(day(2026, 12, 1));
    setSeasonalThemes(false);
    expect(getSeasonalThemes()).toBe(false);
    expect(getThemeChoice()).toBe('light');
    checkSeason(day(2026, 12, 2));
    checkSeason(day(2027, 10, 1));
    expect(getThemeChoice()).toBe('light');
    expect((await loadTheme()).getSeasonalThemes()).toBe(false);
  });

  it('turning them off leaves a theme chosen since the switch', async () => {
    const { setThemeChoice, checkSeason, getThemeChoice, setSeasonalThemes } = await loadTheme();
    checkSeason(day(2026, 12, 1));
    setThemeChoice('slack');
    setSeasonalThemes(false);
    expect(getThemeChoice()).toBe('slack');
  });
});
