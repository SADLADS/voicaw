import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const choose = (code) => vi.stubGlobal('localStorage', { getItem: () => code, setItem() {}, removeItem() {} });

describe('loading translations', () => {
  it('loads only the chosen language beside British English, before anything can look a string up', async () => {
    choose('ru');
    vi.resetModules();
    const { LANGUAGE, resources, t } = await import('./index.js');
    expect(LANGUAGE).toBe('ru');
    expect(Object.keys(resources).sort()).toEqual(['en-GB', 'ru']);
    expect(t('common.cancel')).toBe('Отмена');
  });

  it('keeps to British English alone when that is the language', async () => {
    choose('en-GB');
    vi.resetModules();
    const { resources, t } = await import('./index.js');
    expect(Object.keys(resources)).toEqual(['en-GB']);
    expect(t('common.cancel')).toBe('Cancel');
  });
});
