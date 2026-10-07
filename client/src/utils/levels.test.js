import { describe, it, expect } from 'vitest';
import { compactNumber, levelBadge, levelOf, levelProgress, levelsOn, showsXp, xpName } from './levels';

const settings = { enabled: true, xpPerLevel: 100, xpName: '', levelName: '', levelShort: '' };

describe('levels', () => {
  it('works out levels and progress', () => {
    expect(levelOf(0, settings)).toBe(0);
    expect(levelOf(99, settings)).toBe(0);
    expect(levelOf(250, settings)).toBe(2);
    expect(levelProgress(250, settings)).toEqual({ level: 2, into: 50, needed: 100 });
    expect(levelOf(undefined, settings)).toBe(0);
  });

  it('shortens big numbers without rounding them up', () => {
    expect([0, 999, 1000, 1250, 9999, 12345, 100000, 999999, 1e6, 2.5e9, 1e12].map(compactNumber))
      .toEqual(['0', '999', '1k', '1.2k', '9.9k', '12k', '100k', '999k', '1m', '2.5b', '1t']);
  });

  it('uses the guild\'s names, else the app\'s', () => {
    expect(levelBadge(100000, settings)).toBe('100k lvl');
    expect(levelBadge(1e6, { ...settings, levelShort: 'rk' })).toBe('1m rk');
    expect(xpName(settings)).toBe('XP');
    expect(xpName({ ...settings, xpName: 'Points' })).toBe('Points');
  });

  it('knows when levels are on and XP is shown', () => {
    expect(levelsOn({ levels: settings })).toBe(true);
    expect(levelsOn({ levels: { ...settings, enabled: false } })).toBe(false);
    expect(levelsOn({})).toBe(false);
    expect(showsXp(settings)).toBe(true);
    expect(showsXp({ ...settings, xpPerLevel: 1 })).toBe(false);
  });
});
