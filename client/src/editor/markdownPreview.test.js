import { describe, it, expect } from 'vitest';
import { markdownPreview } from './markdownPreview';

// A line's spans as readable [className, text] pairs (syntax markers as 'syntax').
function spans(line) {
  const [{ spans: found }] = markdownPreview([line]);
  return found.map((s) => [s.className.replace('md-', ''), line.slice(s.from, s.to)]);
}

describe('markdownPreview', () => {
  it('shows bold and italic, keeping the markers (dimmed)', () => {
    expect(spans('**hello** *world*')).toEqual([
      ['syntax', '**'], ['bold', 'hello'], ['syntax', '**'],
      ['syntax', '*'], ['italic', 'world'], ['syntax', '*'],
    ]);
    expect(spans('__u__ _i_ ~~s~~').map(([c]) => c)).toEqual([
      'syntax', 'underline', 'syntax', 'syntax', 'italic', 'syntax', 'syntax', 'strike', 'syntax',
    ]);
  });

  it('shows spoilers, spaces inside allowed, with formatting inside', () => {
    expect(spans('||secret|| and || **big** one ||')).toEqual([
      ['syntax', '||'], ['spoiler', 'secret'], ['syntax', '||'],
      ['syntax', '||'], ['spoiler', ' **big** one '], ['syntax', '**'], ['bold', 'big'], ['syntax', '**'], ['syntax', '||'],
    ]);
    expect(spans('||||')).toEqual([]);
    expect(spans('a || b')).toEqual([]);
  });

  it('nests: ***both***, and bold inside italic', () => {
    expect(spans('***both***')).toEqual([
      ['syntax', '**'], ['bold', '*both*'], ['syntax', '*'], ['italic', 'both'], ['syntax', '*'], ['syntax', '**'],
    ]);
    expect(spans('*a **b** c*')).toEqual([
      ['syntax', '*'], ['italic', 'a **b** c'], ['syntax', '**'], ['bold', 'b'], ['syntax', '**'], ['syntax', '*'],
    ]);
  });

  it("leaves what wouldn't be formatted alone", () => {
    for (const text of ['2 * 3 * 4', '** not bold **', 'snake_case_name', 'a*', '**unclosed', '~single~', '']) {
      expect(spans(text)).toEqual([]);
    }
  });

  it('shows code, with nothing formatted inside it', () => {
    expect(spans('use `**x**` here')).toEqual([['syntax', '`'], ['code', '**x**'], ['syntax', '`']]);
    expect(spans('``a ` b``')).toEqual([['syntax', '``'], ['code', 'a ` b'], ['syntax', '``']]);
    // A closing marker inside code doesn't count.
    expect(spans('*a `b*` c*').map(([c, t]) => `${c}:${t}`)).toContain('italic:a `b*` c');
  });

  it('respects backslash escapes', () => {
    expect(spans('\\*not italic*')).toEqual([['syntax', '\\']]);
  });

  it('marks quotes and code blocks as whole lines, but not headings (like Discord)', () => {
    const lines = markdownPreview(['# Title **x**', '> quoted', '```js', 'const a = **1**;', '```', 'after *it*', '#nope']);
    expect(lines.map((l) => l.block)).toEqual([
      null, 'md-quote', 'md-code-block md-code-block-start', 'md-code-block', 'md-code-block md-code-block-end', null, null,
    ]);
    expect(lines[0].spans.map((s) => s.className)).toEqual(['md-syntax', 'md-bold', 'md-syntax']);
    expect(lines[3].spans).toEqual([]);
    expect(lines[5].spans.map((s) => s.className)).toEqual(['md-syntax', 'md-italic', 'md-syntax']);
  });

  it('keeps an unfinished code block open to the end', () => {
    expect(markdownPreview(['```', 'still code']).map((l) => l.block)).toEqual([
      'md-code-block md-code-block-start', 'md-code-block',
    ]);
  });
});
