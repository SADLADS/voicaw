// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { openBook } from './epubBook';
import { findCoverPath, openEpubPackage } from './epubPackage';
import { epub, xhtml, PNG } from '../../test/epubFixture';

beforeAll(() => {
  let n = 0;
  URL.createObjectURL ??= () => `blob:test/${++n}`;
  URL.revokeObjectURL ??= () => {};
});

const nav = xhtml('<nav epub:type="toc"><ol><li><a href="one.xhtml">One</a><ol><li><a href="two.xhtml#part">Two, part</a></li></ol></li></ol></nav>');

describe('EPUB books', () => {
  it('reads an EPUB 3: title, author, chapters and contents', async () => {
    const book = await openBook(await epub({
      files: { 'nav.xhtml': nav, 'one.xhtml': xhtml('<p>First</p>'), 'two.xhtml': xhtml('<p id="part">Second</p>') },
      properties: { 'nav.xhtml': 'nav' },
      spine: ['b', 'c'],
    }));
    expect(book.title).toBe('The Book');
    expect(book.author).toBe('A. Writer');
    expect(book.chapterCount).toBe(2);
    expect(book.contents).toEqual([{ label: 'One', index: 0, fragment: '', children: [{ label: 'Two, part', index: 1, fragment: 'part', children: [] }] }]);
    const two = await book.chapter(1);
    expect(two.fragment.querySelector('p').textContent).toBe('Second');
    expect(two.fragment.querySelector('p').id).toBe('part');
  });

  it('reads an EPUB 2 NCX for contents', async () => {
    const ncx = '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="p1"><navLabel><text>Chapter 1</text></navLabel><content src="one.xhtml"/></navPoint></navMap></ncx>';
    const book = await openBook(await epub({ files: { 'toc.ncx': ncx, 'one.xhtml': xhtml('<p>x</p>') }, spine: ['b'], toc: 'a' }));
    expect(book.contents).toEqual([{ label: 'Chapter 1', index: 0, fragment: '', children: [] }]);
  });

  it('links chapters to each other, and stylesheets and pictures to the book’s own files', async () => {
    const book = await openBook(await epub({
      files: {
        'one.xhtml': xhtml('<a href="two.xhtml#x">next</a><a href="#here">here</a><img src="pic.png" alt="p"/>', '<link rel="stylesheet" href="style.css"/>'),
        'two.xhtml': xhtml('<p>2</p>'),
        'style.css': 'p { color: red; background: url(pic.png) }',
        'pic.png': PNG,
      },
      spine: ['a', 'b'],
    }));
    const one = await book.chapter(0);
    const [next, here] = one.fragment.querySelectorAll('a');
    expect(next.getAttribute('href')).toBe('#epub:1:x');
    expect(here.getAttribute('href')).toBe('#epub:0:here');
    expect(one.fragment.querySelector('img').getAttribute('src')).toMatch(/^blob:/);
    expect(one.styles[0]).toMatch(/color: red; background: url\("blob:/);
  });

  it('never makes a blob of a file whose bytes aren’t a picture, whatever the manifest says', async () => {
    const book = await openBook(await epub({
      files: { 'one.xhtml': xhtml('<img src="fake.png" alt="x"/><p style="background: url(fake.png)">p</p>'), 'fake.png': '<html><script>alert(1)</script></html>' },
      spine: ['a'],
    }));
    const one = await book.chapter(0);
    expect(one.fragment.querySelector('img').hasAttribute('src')).toBe(false);
    expect(one.fragment.querySelector('p').getAttribute('style')).toBe('background: none');
  });

  it('refuses what isn’t a book', async () => {
    await expect(openBook(new Blob(['not a zip']))).rejects.toThrow();
  });

  it('finds a cover three ways', async () => {
    const files = { 'one.xhtml': xhtml('<p>1</p>'), 'cover.png': PNG };
    const byProperty = await openEpubPackage(await epub({ files, properties: { 'cover.png': 'cover-image' }, spine: ['a'] }));
    expect(await findCoverPath(byProperty)).toBe('OEBPS/cover.png');
    const byMeta = await openEpubPackage(await epub({ files, ids: { 'cover.png': 'cov' }, metadata: '<meta name="cover" content="cov"/>', spine: ['a'] }));
    expect(await findCoverPath(byMeta)).toBe('OEBPS/cover.png');
    const byPage = await openEpubPackage(await epub({
      files: { 'cover.xhtml': xhtml('<div><img src="images/c.png"/></div>'), 'images/c.png': PNG },
      spine: ['a'],
    }));
    expect(await findCoverPath(byPage)).toBe('OEBPS/images/c.png');
    expect(await findCoverPath(await openEpubPackage(await epub({ files, spine: ['a'] })))).toBeNull();
  });
});
