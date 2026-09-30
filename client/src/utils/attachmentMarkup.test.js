import { describe, it, expect } from 'vitest';
import {
  makePlaceholder,
  placeholderIdFromUrl,
  findPlaceholderIds,
  removePlaceholder,
  replacePlaceholders,
  summarizeAttachments,
} from './attachmentMarkup';

describe('attachmentMarkup', () => {
  it('builds placeholders, escaping markdown syntax in the file name', () => {
    expect(makePlaceholder(3, 'cat.png')).toBe('![cat.png](attachment:3)');
    expect(makePlaceholder(4, 'a [b] \\c.txt')).toBe('![a \\[b\\] \\\\c.txt](attachment:4)');
    expect(makePlaceholder(5, 'a*b*_c_`d`~~e~~&amp;.txt')).toBe(
      '![a\\*b\\*\\_c\\_\\`d\\`\\~\\~e\\~\\~\\&amp;.txt](attachment:5)'
    );
  });

  it('keeps file names intact as rendered alt text', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { default: ReactMarkdown } = await import('react-markdown');
    const { default: remarkGfm } = await import('remark-gfm');
    const { default: remarkEmoji } = await import('remark-emoji');
    const names = ['a*b*.pdf', 'my_file_.txt', 'tick`s`.md', '~~s~~.txt', 'a&amp;b.txt', 'we[ird].png', 'back\\slash.txt'];

    for (const name of names) {
      let alt;
      renderToStaticMarkup(
        createElement(ReactMarkdown, {
          remarkPlugins: [remarkGfm, remarkEmoji],
          urlTransform: (u) => u,
          components: { img: (props) => { alt = props.alt; return null; } },
        }, makePlaceholder(1, name))
      );
      expect(alt).toBe(name);
    }
  });

  it('only treats attachment:<positive integer> as a placeholder URL', () => {
    expect(placeholderIdFromUrl('attachment:12')).toBe(12);
    expect(placeholderIdFromUrl('attachment:0')).toBeNull();
    expect(placeholderIdFromUrl('attachment:abc')).toBeNull();
    expect(placeholderIdFromUrl('https://example.com/a.png')).toBeNull();
    expect(placeholderIdFromUrl(undefined)).toBeNull();
  });

  it('finds the placeholders referenced in text, including escaped names', () => {
    const text = `hi ${makePlaceholder(1, 'a.png')} and ${makePlaceholder(2, 'we[ird].zip')}
      ![external](https://example.com/x.png) [not an embed](attachment:9)`;
    expect(findPlaceholderIds(text)).toEqual(new Set([1, 2]));
  });

  it('removes just the requested placeholder', () => {
    const text = `${makePlaceholder(1, 'a.png')} middle ${makePlaceholder(2, 'b.png')}`;
    expect(removePlaceholder(text, 1)).toBe(` middle ${makePlaceholder(2, 'b.png')}`);
  });

  it('swaps placeholders for final URLs, keeping alt text and leaving unknown ids alone', () => {
    const text = `${makePlaceholder(1, 'we[ird].png')} ${makePlaceholder(2, 'b.png')}`;
    expect(replacePlaceholders(text, { 1: 'https://s3.test/uploads/x.bin#k=1' })).toBe(
      '![we\\[ird\\].png](https://s3.test/uploads/x.bin#k=1) ![b.png](attachment:2)'
    );
  });

  it('summarizes embeds so URLs and keys are not shown in previews', () => {
    const text = 'look ![we\\[ird\\].png](https://s3.test/uploads/x.bin#v=1&k=SECRET) ![](https://e.com/y.png)';
    expect(summarizeAttachments(text)).toBe('look 📎 we[ird].png 📎 attachment');
    expect(summarizeAttachments(null)).toBeNull();
  });

  it("doesn't give a spoiler away by its name in previews", () => {
    const text = '![ending.png](https://s3.test/uploads/x.bin#v=1&k=SECRET&t=image%2Fpng&s=1&sp=1)';
    expect(summarizeAttachments(text)).toBe('📎 spoiler');
  });
});
