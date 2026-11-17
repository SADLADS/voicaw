import { describe, it, expect } from 'vitest';
import { cleanLink, cleanLinksInText, compileRules } from './linkCleaner';
import { BUILT_IN_RULES, KEEP_RULES } from './linkRulesBuiltIn';

const builtIn = compileRules(BUILT_IN_RULES, KEEP_RULES);

describe('cleanLink', () => {
  it('takes out tracking and keeps what the link needs', () => {
    expect(cleanLink('https://x.com/Channel4News/status/2122354639941321113?a=lnRAVVaoK6hYw0NsZ2w&s=20', builtIn))
      .toBe('https://x.com/Channel4News/status/2122354639941321113');
    expect(cleanLink('https://youtu.be/abc?si=XYZ&t=90', builtIn)).toBe('https://youtu.be/abc?t=90');
    expect(cleanLink('https://www.youtube.com/watch?v=abc&list=PL1&index=3&pp=ygU&t=1m2s', builtIn))
      .toBe('https://www.youtube.com/watch?v=abc&list=PL1&index=3&t=1m2s');
    expect(cleanLink('https://example.com/a?id=5&utm_source=news&utm_medium=email&fbclid=1#part', builtIn))
      .toBe('https://example.com/a?id=5#part');
  });

  it('leaves alone what it has nothing to take out of, exactly as written', () => {
    for (const link of [
      'https://example.com/a?b=%2F&c',
      'https://example.com/?s=20&t=5',
      'https://EXAMPLE.com/path?q=a+b',
      'https://example.com/no-query#utm_source=x',
      'not a link?utm_source=x',
    ]) expect(cleanLink(link, builtIn)).toBe(link);
  });

  it("follows hosts, exclusions, address patterns, regexes, 'every parameter' and exceptions", () => {
    const rules = compileRules([
      { p: 'ref', h: ['shop.test'], x: ['keep.shop.test'] },
      { p: '/^pk_/' },
      { p: '*', u: '\\/out\\?' },
      { p: 'cid', h: ['google.*'] },
      { p: 'gone' },
      { p: 'gone', h: ['mine.test'], e: 1 },
    ]);
    expect(cleanLink('https://www.shop.test/x?ref=1&a=2', rules)).toBe('https://www.shop.test/x?a=2');
    expect(cleanLink('https://keep.shop.test/x?ref=1', rules)).toBe('https://keep.shop.test/x?ref=1');
    expect(cleanLink('https://a.test/?pk_campaign=1&pk=2', rules)).toBe('https://a.test/?pk=2');
    expect(cleanLink('https://a.test/out?u=1&v=2#x', rules)).toBe('https://a.test/out#x');
    expect(cleanLink('https://www.google.co.uk/?cid=1&q=a', rules)).toBe('https://www.google.co.uk/?q=a');
    expect(cleanLink('https://notgoogle.com/?cid=1', rules)).toBe('https://notgoogle.com/?cid=1');
    expect(cleanLink('https://a.test/?gone=1', rules)).toBe('https://a.test/');
    expect(cleanLink('https://mine.test/?gone=1', rules)).toBe('https://mine.test/?gone=1');
  });

  it('skips rules that make no sense', () => {
    const rules = compileRules([{ p: '/(/' }, { p: 5 }, null, { p: 'a', u: '(' }, { p: 'b' }], 'nope');
    expect(rules.remove).toHaveLength(1);
  });
});

describe('cleanLinksInText', () => {
  it('cleans every link but those in code, keeping punctuation after them', () => {
    const text = 'see (https://a.test/?utm_source=x), https://b.test/?fbclid=1! and `https://c.test/?utm_source=x`\n```\ncurl https://d.test/?gclid=1\n```';
    expect(cleanLinksInText(text, builtIn))
      .toBe('see (https://a.test/), https://b.test/! and `https://c.test/?utm_source=x`\n```\ncurl https://d.test/?gclid=1\n```');
  });

  it('gives back text without links as it was', () => {
    expect(cleanLinksInText('hello utm_source=x', builtIn)).toBe('hello utm_source=x');
    expect(cleanLinksInText(undefined, builtIn)).toBeUndefined();
  });
});
