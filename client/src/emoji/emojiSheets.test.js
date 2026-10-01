import { describe, it, expect } from 'vitest';
import data from '@emoji-mart/data/sets/15/twitter.json';
import { CATEGORY_SHEETS, SHEET_COLUMNS, SKIN_TONES, emojiSheets, sheetCss, sheetKey, sheetPath, spriteMap, spritePosition } from './emojiSheets';
import { buildEmojiIndex, emojiSheetUrl } from './emojiIndex';

describe('emoji sprite sheets', () => {
  it('has a sheet per category, as the service worker expects', () => {
    expect(data.categories.map((c) => c.id)).toEqual(CATEGORY_SHEETS);
    expect(emojiSheets(data).map((s) => s.name)).toEqual([...CATEGORY_SHEETS, 'tone1', 'tone2', 'tone3', 'tone4', 'tone5']);
  });

  it('puts every emoji and skin tone the picker can show on a sheet', () => {
    const sprites = spriteMap(data);
    const missing = Object.values(data.emojis).flatMap((emoji) => emoji.skins.map((skin) => skin.unified)).filter((u) => !sprites.has(u));
    expect(missing).toEqual([]);
    // Every emoji with tones has all of them (so tone sheets line up).
    expect(Object.values(data.emojis).every((e) => e.skins.length === 1 || e.skins.length === SKIN_TONES + 1)).toBe(true);
  });

  it('finds a cell by its place on the sheet', () => {
    const sprites = spriteMap(data);
    const people = emojiSheets(data)[0].cells;
    const sprite = sprites.get(people[SHEET_COLUMNS + 2]);
    expect(sprite).toMatchObject({ sheet: 'people', col: 2, row: 1, rows: Math.ceil(people.length / SHEET_COLUMNS) });
    // 👍🏽 (tone 3) is on the tone 3 sheet.
    expect(sprites.get('1f44d-1f3fd').sheet).toBe('tone3');
  });

  it('draws a cell from its sheet\'s class and a background position in percent', () => {
    expect(spritePosition({ col: 15, row: 0, rows: 3 })).toBe('100% 0%');
    expect(spritePosition({ col: 3, row: 2, rows: 5 })).toBe('20% 50%');
    expect(spritePosition({ col: 0, row: 0, rows: 1 })).toBe('0% 0');
    const css = sheetCss(data, (name) => `/emoji/${name}.webp`);
    const foods = Math.ceil(data.categories.find((c) => c.id === 'foods').emojis.length / SHEET_COLUMNS);
    expect(css).toContain(`.emoji-sheet-foods{background-image:url("/emoji/foods.webp");background-size:${SHEET_COLUMNS * 100}% ${foods * 100}%}`);
    expect(css).toContain('.emoji-sheet-tone5{');
  });

  it('serves sheets under a key that changes with the art and data versions', () => {
    expect(sheetKey('15.0.0', '1.2.1')).not.toBe(sheetKey('15.1.0', '1.2.1'));
    expect(sheetPath('k', 'people')).toBe('sheets/k/people.webp');
    expect(emojiSheetUrl('people')).toMatch(/^\/emoji\/sheets\/[^/]+\/people\.webp$/);
    expect(buildEmojiIndex(data).sprites.size).toBeGreaterThan(3000);
  });
});
