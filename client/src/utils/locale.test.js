import { describe, it, expect, vi, afterEach } from 'vitest';
import { userLocale } from './locale';

afterEach(() => vi.unstubAllGlobals());

describe('userLocale', () => {
  it("is the browser's language", () => {
    vi.stubGlobal('navigator', { language: 'de-AT', languages: ['de-AT', 'en'] });
    expect(userLocale()).toBe('de-AT');
  });

  it('is British English without one (or with a broken one)', () => {
    vi.stubGlobal('navigator', { language: '', languages: [] });
    expect(userLocale()).toBe('en-GB');
    vi.stubGlobal('navigator', undefined);
    expect(userLocale()).toBe('en-GB');
    vi.stubGlobal('navigator', { language: 'not a locale!' });
    expect(userLocale()).toBe('en-GB');
  });
});
