// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EpubReader from './EpubReader';
import { epub, xhtml } from '../test/epubFixture';

beforeAll(() => {
  let n = 0;
  URL.createObjectURL ??= () => `blob:test/${++n}`;
  URL.revokeObjectURL ??= () => {};
  globalThis.CSS ??= {};
  CSS.escape ??= (value) => value;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.scrollBy ??= () => {};
});

beforeEach(() => localStorage.clear());

const nav = xhtml('<nav epub:type="toc"><ol><li><a href="one.xhtml">Opening</a></li><li><a href="two.xhtml">Middle</a></li></ol></nav>');
const book = () => epub({
  files: {
    'nav.xhtml': nav,
    'one.xhtml': xhtml('<h1>One</h1><p>Go <a href="two.xhtml#end">on</a>.</p><script>window.ran = true</script><img src="x.png" onerror="window.ran = true"/>'),
    'two.xhtml': xhtml('<h1>Two</h1><p id="end">The end</p>'),
  },
  properties: { 'nav.xhtml': 'nav' },
  spine: ['b', 'c'],
});
const shadow = () => document.querySelector('.epub-reader-page > div')?.shadowRoot;

describe('EpubReader', () => {
  it('opens a book at its first chapter, follows its links and its contents, and closes with Escape', async () => {
    const onClose = vi.fn();
    const file = await book();
    render(<EpubReader name="book.epub" load={async () => file} positionKey="k.bin" onClose={onClose} />);
    expect(await screen.findByRole('dialog', { name: 'The Book' })).toBeInTheDocument();
    expect(screen.getByText('A. Writer')).toBeInTheDocument();
    await waitFor(() => expect(shadow()?.querySelector('h1')?.textContent).toBe('One'));
    expect(window.ran).toBeUndefined();
    expect(shadow().querySelector('script')).toBeNull();
    expect(screen.getByText('Chapter 1 of 2')).toBeInTheDocument();

    fireEvent.click(shadow().querySelector('a'));
    await waitFor(() => expect(shadow().querySelector('h1').textContent).toBe('Two'));
    expect(JSON.parse(localStorage.getItem('epubPosition:k.bin')).index).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Contents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Opening' }));
    await waitFor(() => expect(shadow().querySelector('h1').textContent).toBe('One'));

    fireEvent.click(screen.getByRole('button', { name: /Next chapter/ }));
    await waitFor(() => expect(shadow().querySelector('h1').textContent).toBe('Two'));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('reopens a book where it was left', async () => {
    localStorage.setItem('epubPosition:k.bin', JSON.stringify({ index: 1, fraction: 0 }));
    const file = await book();
    render(<EpubReader name="book.epub" load={async () => file} positionKey="k.bin" onClose={() => {}} />);
    await waitFor(() => expect(shadow()?.querySelector('h1')?.textContent).toBe('Two'));
  });

  it("says when a book can't be opened, and when it couldn't be downloaded", async () => {
    const { unmount } = render(<EpubReader name="x.epub" load={async () => new Blob(['nope'])} onClose={() => {}} />);
    expect(await screen.findByText("This book couldn't be opened")).toBeInTheDocument();
    unmount();
    render(<EpubReader name="x.epub" load={async () => { throw new TypeError('Failed to fetch'); }} onClose={() => {}} />);
    expect(await screen.findByText('Download failed')).toBeInTheDocument();
  });
});
