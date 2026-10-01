import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import data from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex, twemojiFile, emojiImageUrl, splitEmoji, isEmojiOnly } from './emojiIndex';

const require = createRequire(import.meta.url);
const svgDir = path.dirname(require.resolve('@twemoji/svg/package.json'));

let index;
beforeAll(() => {
  index = buildEmojiIndex(data);
});

describe('emoji index', () => {
  it('has an image for every emoji and skin tone the picker can show', () => {
    const files = new Set(fs.readdirSync(svgDir));
    const missing = [];
    for (const emoji of index.emojis.values()) {
      for (const skin of emoji.skins) {
        if (!files.has(`${twemojiFile(skin.unified)}.svg`)) missing.push(`${emoji.id} ${skin.unified}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('maps code points to Twemoji file names', () => {
    expect(twemojiFile('1f604')).toBe('1f604');
    expect(twemojiFile('2764-fe0f')).toBe('2764'); // no ZWJ: FE0F dropped
    expect(twemojiFile('2764-fe0f-200d-1f525')).toBe('2764-fe0f-200d-1f525'); // ZWJ: kept
    expect(twemojiFile('0023-fe0f-20e3')).toBe('23-20e3'); // leading zeros dropped
    expect(twemojiFile('1f441-fe0f-200d-1f5e8-fe0f')).toBe('1f441-200d-1f5e8'); // exception
    expect(emojiImageUrl('1f604')).toBe('/emoji/1f604.svg');
  });

  it('groups emoji into Discord-like categories', () => {
    expect(index.categories.map((c) => c.name)).toEqual([
      'Smileys & People', 'Animals & Nature', 'Food & Drink', 'Activity',
      'Travel & Places', 'Objects', 'Symbols', 'Flags',
    ]);
    expect(index.categories[0].emojis[0].id).toBe('grinning');
  });

  it('looks up shortcodes and aliases', () => {
    expect(index.byShortcode.get('smile').skins[0].native).toBe('😄');
    expect(index.byShortcode.get('+1').skins[0].native).toBe('👍');
    expect(index.byShortcode.get('thumbsup')?.id ?? index.search('thumbsup')[0].id).toBe('+1');
  });

  it('searches shortcodes first, then names and keywords', () => {
    const results = index.search('smi').map((e) => e.id);
    expect(results[0]).toBe('smile');
    expect(results).toContain('smiley');
    expect(index.search(':heart').map((e) => e.id)[0]).toBe('heart');
    expect(index.search('pizza')[0].id).toBe('pizza');
    expect(index.search('')).toEqual([]);
  });

  it('searches several words', () => {
    expect(index.search('thumbs up')[0].id).toBe('+1');
    expect(index.search('heart eyes')[0].id).toBe('heart_eyes');
    expect(index.search('party popper')[0].id).toBe('tada');
    expect(index.search('red heart').map((e) => e.id)).toContain('heart');
    expect(index.search('zzzz qqqq')).toEqual([]);
  });
});

describe('splitting text into emoji', () => {
  it('finds emoji, preferring whole sequences over their parts', () => {
    const parts = splitEmoji('hi 👍🏽 and 👨‍👩‍👧 and 🇬🇧!', index);
    expect(parts.filter((p) => p.emoji).map((p) => p.native)).toEqual(['👍🏽', '👨‍👩‍👧', '🇬🇧']);
    expect(parts.map((p) => p.text ?? p.native).join('')).toBe('hi 👍🏽 and 👨‍👩‍👧 and 🇬🇧!');
    expect(parts.find((p) => p.native === '👍🏽').skin.unified).toBe('1f44d-1f3fd');
  });

  it('recognises emoji typed without the FE0F variation selector', () => {
    const [part] = splitEmoji('❤', index);
    expect(part.emoji.id).toBe('heart');
  });

  it('leaves plain text and digits alone', () => {
    expect(splitEmoji('abc 123 #tag *', index)).toEqual([{ text: 'abc 123 #tag *' }]);
  });

  it('detects emoji-only messages (up to 27)', () => {
    expect(isEmojiOnly('😄', index)).toBe(true);
    expect(isEmojiOnly(' 😄 👍🏽  ', index)).toBe(true);
    expect(isEmojiOnly('😄 hi', index)).toBe(false);
    expect(isEmojiOnly('😄'.repeat(28), index)).toBe(false);
    expect(isEmojiOnly('', index)).toBe(false);
  });
});

describe('isEmojiOnly with custom emoji', () => {
  it('counts custom emoji as emoji', () => {
    const idx = buildEmojiIndex(data);
    expect(isEmojiOnly('<:blob:1>', idx)).toBe(true);
    expect(isEmojiOnly('<:blob:1> 😄 <:cat:2>', idx)).toBe(true);
    expect(isEmojiOnly('<:blob:1> hi', idx)).toBe(false);
  });
});
