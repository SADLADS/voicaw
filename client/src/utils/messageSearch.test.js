import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { HAS, indexedWords, messageMatcher, searchHas, searchText, searchWords } from './messageSearch';

const require = createRequire(import.meta.url);
const server = require('../../../server/searchText.js');

const SAMPLES = [
  'plain words, with punctuation!',
  'hi <@12> and <@&3> in <#4> :) <:party:99>',
  '![holiday.jpg](https://s3.example/a/b#v=1&k=KEY&t=image/jpeg) look',
  '![clip.mp4](https://s3.example/c#v=2&k=K2&t=video/mp4)',
  '![song.ogg](https://s3.example/d#v=1&k=K3&t=audio/ogg) ![GIF](https://klipy.example/g.gif#gif)',
  'see https://example.com/page and ![x](https://pics.example/p.png)',
  'poll:v1:{"q":"Where?","o":[{"id":"aaaa1111","t":"Park"},{"id":"bbbb2222","t":"Beach"}]}',
  'poll:v1:{broken',
  'escaped ![a \\] b](https://s3.example/e#v=1&k=K&t=text/plain)',
];

describe('messageSearch', () => {
  it("sees a message as guild search's server code does", () => {
    for (const content of SAMPLES) {
      expect(searchText(content)).toBe(server.searchText({ content }));
      expect(searchHas(content)).toBe(server.searchHas({ content }));
    }
    expect(HAS).toEqual(server.HAS);
  });

  it('never keeps an attachment key in the words', () => {
    expect(indexedWords(SAMPLES[2])).toBe('holiday jpg look');
  });

  it('splits words without case or accents', () => {
    expect(searchWords('Crème BRÛLÉE, naïve—café')).toEqual(['creme', 'brulee', 'naive', 'cafe']);
  });

  it('matches like the server: prefixes, exact phrases, emoji as written', () => {
    const entry = (p, s = 1) => ({ s, p, n: indexedWords(p), h: searchHas(p) });
    const m = (params, p) => messageMatcher(params)(entry(p));
    expect(m({ content: 'hol' }, SAMPLES[2])).toBe(true);
    expect(m({ content: 'olid' }, SAMPLES[2])).toBe(false);
    expect(m({ content: '"plain words"' }, SAMPLES[0])).toBe(true);
    expect(m({ content: '"plain word"' }, SAMPLES[0])).toBe(false);
    expect(m({ content: 'plain wor' }, SAMPLES[0])).toBe(true);
    expect(m({ content: 'words plain' }, SAMPLES[0])).toBe(true);
    expect(m({ content: '🎉' }, 'party 🎉')).toBe(true);
    expect(m({ content: '🎉' }, 'party')).toBe(false);
    expect(m({ content: 'party', author_id: [2] }, 'party')).toBe(false);
    expect(m({ mentions: [12] }, SAMPLES[1])).toBe(true);
    expect(m({ has: ['video'] }, SAMPLES[3])).toBe(true);
    expect(m({ has: ['video', 'link'] }, SAMPLES[3])).toBe(false);
  });
});
