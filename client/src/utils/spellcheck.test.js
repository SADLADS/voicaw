// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('spellcheck', () => {
  it('is on by default, and puts it on the page', async () => {
    const { applySpellcheck, isSpellcheckEnabled } = await import('./spellcheck');
    applySpellcheck();
    expect(isSpellcheckEnabled()).toBe(true);
    expect(document.documentElement.spellcheck).toBe(true);
  });

  it('is turned off and on for this device', async () => {
    const { setSpellcheckEnabled } = await import('./spellcheck');
    setSpellcheckEnabled(false);
    expect(document.documentElement.spellcheck).toBe(false);
    expect(localStorage.getItem('spellcheck')).toBe('off');

    vi.resetModules();
    const reloaded = await import('./spellcheck');
    expect(reloaded.isSpellcheckEnabled()).toBe(false);
    reloaded.setSpellcheckEnabled(true);
    expect(document.documentElement.spellcheck).toBe(true);
    expect(localStorage.getItem('spellcheck')).toBe(null);
  });
});
