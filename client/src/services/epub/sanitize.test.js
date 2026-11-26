// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeChapter, sanitizeCss, sanitizeSvgFile } from './sanitize';

// The book's files: pictures under OEBPS/ that are real PNGs resolve, anything else doesn't
// (as epubBook's resource() does for a file whose bytes aren't a picture).
const SVG_FILE = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><image xlink:href="pic.png"/><circle onload="alert(1)" r="5"/></svg>';
const ctx = {
  path: 'OEBPS/one.xhtml',
  chapterIndex: (path) => ['OEBPS/one.xhtml', 'OEBPS/two.xhtml'].indexOf(path),
  resource: async (path) => (path === 'OEBPS/pic.png' ? 'blob:app/pic' : null),
  svg: async (path) => (path === 'OEBPS/art.svg' ? sanitizeSvgFile(SVG_FILE, { ...ctx, path }) : null),
};
const clean = async (markup) => {
  const div = document.createElement('div');
  div.append(await sanitizeChapter(markup, ctx));
  return div;
};
// What would make a browser fetch: an attribute holding another site's address, or CSS that
// still could (blocked rules and functions may keep the address as dead text).
const fetchingCss = /url\(\s*["']?(?:[a-z]+:)?\/\/|@import|@font-face|image-set\(|(?:^|[^-])image\(|cross-fade\(/i;
const attributesWithAddress = (root) => [...root.querySelectorAll('*')]
  .flatMap((el) => [...el.attributes])
  .filter((attr) => (attr.name === 'style' ? fetchingCss.test(attr.value) : /evil\.example/.test(attr.value)));

describe('sanitising a book', () => {
  it('runs nothing: scripts, handlers, javascript: and data: links, frames, forms, refreshes', async () => {
    const div = await clean(`
      <script>alert(1)</script>
      <img src="pic.png" onerror="alert(1)" onload="alert(2)"/>
      <p onclick="alert(3)" style="color: red">text</p>
      <a href="javascript:alert(4)">js</a><a href="data:text/html,<script>alert(5)</script>">data</a>
      <a href="JaVaScRiPt&#58;alert(6)">js2</a>
      <iframe src="https://evil.example/"></iframe><object data="x.swf"></object><embed src="x"/>
      <form action="https://evil.example/"><input name="q"/><button formaction="https://evil.example">b</button></form>
      <base href="https://evil.example/"/><meta http-equiv="refresh" content="0;url=https://evil.example/"/>
      <link rel="stylesheet" href="https://evil.example/x.css"/>
      <template><img src="x" onerror="alert(7)"/></template>
      <svg><a xlink:href="javascript:alert(8)"><text>t</text></a><set attributeName="href" to="javascript:alert(9)"/><animate attributeName="href" values="javascript:alert(10)"/></svg>
      <math><mi xlink:href="javascript:alert(11)">x</mi></math>`);
    const html = div.innerHTML;
    expect(html).not.toMatch(/<(script|iframe|object|embed|form|input|button|base|meta|link|template|set|animate)\b/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/javascript|data:text/i);
    expect(div.querySelector('img').getAttribute('src')).toBe('blob:app/pic');
    expect(div.querySelector('p').textContent).toBe('text');
  });

  it('loads nothing from other sites: pictures, CSS, fonts, SVG paints', async () => {
    const div = await clean(`
      <img src="https://evil.example/track.png" alt="a"/><img src="//evil.example/x.png"/>
      <img srcset="https://evil.example/x.png 2x"/><video poster="https://evil.example/p.png" src="https://evil.example/v.mp4"></video>
      <audio src="https://evil.example/a.mp3"></audio><table background="https://evil.example/bg.png"><tr><td>x</td></tr></table>
      <div style="background: url(https://evil.example/a.png)">x</div>
      <div style="background-image: u\\72 l(https://evil.example/b.png)">x</div>
      <div style="background: image-set('https://evil.example/c.png' 1x)">x</div>
      <style>@import "https://evil.example/d.css"; @font-face { font-family: f; src: url(https://evil.example/f.woff) } p { background: url( "https://evil.example/e.png" /**/ ) }</style>
      <svg><image href="https://evil.example/s.png"/><use href="https://evil.example/u.svg#a"/><rect fill="url(https://evil.example/g.svg#p)"/><rect fill="url(#local)"/></svg>
      <img src="notapicture.png"/>`);
    expect(attributesWithAddress(div)).toEqual([]);
    for (const style of div.querySelectorAll('style')) expect(style.textContent).not.toMatch(fetchingCss);
    expect(div.querySelector('rect[fill="url(#local)"]')).not.toBeNull();
    // The picture whose bytes aren't one is left with no address at all.
    expect([...div.querySelectorAll('img')].every((img) => !img.hasAttribute('src'))).toBe(true);
    expect(div.querySelector('img').getAttribute('alt')).toBe('a');
  });

  it('keeps links to other sites as links that open elsewhere, and links inside the book as jumps', async () => {
    const div = await clean('<a href="https://example.org/ok">site</a><a href="two.xhtml#n1">note</a><a href="missing.xhtml">gone</a><a href="mailto:a@example.org">mail</a><a href="ftp://example.org">ftp</a>');
    const [site, note, gone, mail, ftp] = div.querySelectorAll('a');
    expect(site.getAttribute('href')).toBe('https://example.org/ok');
    expect(site.getAttribute('target')).toBe('_blank');
    expect(site.getAttribute('rel')).toBe('noopener noreferrer');
    expect(note.getAttribute('href')).toBe('#epub:1:n1');
    expect(note.hasAttribute('target')).toBe(false);
    expect(gone.hasAttribute('href')).toBe(false);
    expect(mail.getAttribute('href')).toBe('mailto:a@example.org');
    expect(ftp.hasAttribute('href')).toBe(false);
  });

  it('puts an SVG picture inline, sanitised, never as an SVG file', async () => {
    const div = await clean('<img src="art.svg" alt="Art" class="wide"/>');
    expect(div.querySelector('img')).toBeNull();
    const box = div.querySelector('.epub-svg-image');
    expect(box.getAttribute('role')).toBe('img');
    expect(box.getAttribute('aria-label')).toBe('Art');
    expect(box.className).toContain('wide');
    expect(box.innerHTML).not.toMatch(/script|foreignObject|onload/i);
    expect(box.querySelector('image').getAttribute('href')).toBe('blob:app/pic');
  });

  it('cleans CSS: url()s resolved in the book, everything that fetches blocked', async () => {
    const css = await sanitizeCss(`
      @import url(other.css);
      @IMPORT 'x.css';
      p { background: url("pic.png"); color: blue }
      q { background: url(missing.png) }
      r { cursor: \\75rl(https://evil.example/c) }
      s { background: -webkit-image-set("https://evil.example/w.png" 1x) }
      t { behavior: url(x.htc); -moz-binding: url(y.xml) }
      u { content: "\\"; background: url(https://evil.example/z.png) }`, 'OEBPS/style.css', ctx.resource);
    expect(css).not.toMatch(fetchingCss);
    expect(css).toContain('url("blob:app/pic")');
    expect(css).toContain('color: blue');
    expect(css).not.toMatch(/(behavior|-moz-binding)\s*:/);
  });
});
