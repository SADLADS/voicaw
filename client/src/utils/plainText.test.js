import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkEmoji from 'remark-emoji';
import { remarkDiscord } from './remarkDiscord';
import { isPlainText } from './plainText';

// What a message's markdown would draw (MessageList's remark plugins).
const render = (md) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkDiscord, remarkEmoji] }, md));

describe('isPlainText', () => {
  it('takes text that markdown draws as typed, in one paragraph', () => {
    for (const text of ['Leicester Square', 'IMAX 3', "It's 2h 15m, isn't it?", 'Rated 12A. Book now!', 'a/b "quoted"', 'two  spaces']) {
      expect(isPlainText(text), text).toBe(true);
      expect(render(text)).toBe(`<p>${renderToStaticMarkup(createElement('span', null, text)).slice(6, -7)}</p>`);
    }
  });

  it('leaves anything markdown or the plugins would change to the parser', () => {
    for (const text of [
      '**bold**', '_it_', '__u__', '~~s~~', '||spoiler||', '`code`', '# heading', '> quote', '- item', '+ item',
      '1. first', '2) second', 'see www.example.com', 'https://a.test', 'a@b.test', ':smile:', '<@12>', '<#3>',
      '&amp;', 'two\nlines', ' leading', 'trailing ', '', 'café', '👍', '[link](x)', 'a | b', 'a = b',
    ]) {
      expect(isPlainText(text), text).toBe(false);
    }
    expect(isPlainText(undefined)).toBe(false);
  });
});
