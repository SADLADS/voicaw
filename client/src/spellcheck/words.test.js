import { describe, it, expect } from 'vitest';
import { wordAt, wordsIn } from './words';

const words = (text) => wordsIn(text).map((w) => w.word);

describe('spellchecked words', () => {
  it('finds words and where they are, apostrophes and accents included', () => {
    expect(wordsIn('Hello wrold')).toEqual([{ word: 'Hello', from: 0, to: 5 }, { word: 'wrold', from: 6, to: 11 }]);
    expect(words("don't o’clock café naïve")).toEqual(["don't", 'o’clock', 'café', 'naïve']);
    expect(words("the dogs' bowls")).toEqual(['the', 'dogs', 'bowls']);
  });

  it('leaves out links, mentions, emoji codes, digits, acronyms and mixed case', () => {
    expect(words('see https://exmaple.com/pathh and www.fooo.org or me@mial.com')).toEqual(['see', 'and', 'or']);
    expect(words('@ottoo in #genral :smiel: ok')).toEqual(['in', 'ok']);
    expect(words('abc123 snake_case 3rd NASA iPhone JavaScript a I')).toEqual([]);
    expect(words('Sentence starts')).toEqual(['Sentence', 'starts']);
  });

  it('finds the word at an offset', () => {
    expect(wordAt('one twoo three', 5)).toEqual({ word: 'twoo', from: 4, to: 8 });
    expect(wordAt('one twoo three', 8)?.word).toBe('twoo');
    expect(wordAt('one   two', 4)).toBeNull();
  });
});
