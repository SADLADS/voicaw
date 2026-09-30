import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { hideSpoilers, remarkDiscord } from './remarkDiscord';

const render = (md) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkDiscord] }, md));

describe('remarkDiscord', () => {
  it('makes __text__ underline, keeping **text** bold', () => {
    expect(render('__under__ **bold** ___both___')).toBe(
      '<p><u>under</u> <strong>bold</strong> <em><u>both</u></em></p>'
    );
  });

  it("keeps Discord's syntax", () => {
    expect(render('# One\n## Two\n### Three')).toBe('<h1>One</h1>\n<h2>Two</h2>\n<h3>Three</h3>');
    expect(render('> quoted')).toContain('<blockquote>');
    expect(render('- a\n- b')).toContain('<ul>');
    expect(render('```\ncode\n```')).toContain('<pre><code>code\n</code></pre>');
    expect(render('~~gone~~ `x` [link](https://a.test)')).toBe(
      '<p><del>gone</del> <code>x</code> <a href="https://a.test">link</a></p>'
    );
  });

  it("leaves what Discord doesn't have as typed", () => {
    expect(render('#### Four')).toBe('<p>#### Four</p>');
    expect(render('text\n===')).toBe('<p>text\n===</p>');
    expect(render('a\n---\nb')).toBe('<p>a\n---\nb</p>');
    expect(render('    indented')).toBe('<p>indented</p>');
    expect(render('| a | b |\n| - | - |\n| 1 | 2 |')).not.toContain('<table');
    expect(render('- [ ] task')).not.toContain('checkbox');
    expect(render('[x]: https://a.test')).toBe('<p>[x]: <a href="https://a.test">https://a.test</a></p>');
  });

  it('makes ||text|| a spoiler, with formatting inside, but not in code', () => {
    expect(render('look ||the **end**|| here')).toBe(
      '<p>look <span class="spoiler">the <strong>end</strong></span> here</p>'
    );
    expect(render('||a|| and ||b||')).toBe('<p><span class="spoiler">a</span> and <span class="spoiler">b</span></p>');
    expect(render('*||in italics||*')).toBe('<p><em><span class="spoiler">in italics</span></em></p>');
    expect(render('`||code||` ||||')).toBe('<p><code>||code||</code> ||||</p>');
    expect(render('a || b')).toBe('<p>a || b</p>');
  });

  it('shows every blank line between blocks', () => {
    const blank = '<p class="blank-line"></p>';
    expect(render('a\nb')).toBe('<p>a\nb</p>');
    expect(render('a\n\nb')).toBe(`<p>a</p>\n${blank}\n<p>b</p>`);
    expect(render('a\n\n\n\nb')).toBe(`<p>a</p>\n${blank}\n${blank}\n${blank}\n<p>b</p>`);
    expect(render('# Title\n\n\ntext')).toBe(`<h1>Title</h1>\n${blank}\n${blank}\n<p>text</p>`);
    expect(render('> one\n>\n> two')).toBe(`<blockquote>\n<p>one</p>\n${blank}\n<p>two</p>\n</blockquote>`);
    expect(render('```\nx\n\n\ny\n```')).toContain('x\n\n\ny');
  });

  it('hides spoilers in plain text', () => {
    expect(hideSpoilers('the ||butler|| did it, || twice ||')).toBe('the [spoiler] did it, [spoiler]');
    expect(hideSpoilers('a || b')).toBe('a || b');
  });
});
