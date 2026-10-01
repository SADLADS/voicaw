import { describe, it, expect } from 'vitest';
import { docToMarkdown, markdownToDoc } from './documentMarkdown';
import { documentExcerpt } from './documentText';

const roundTrip = (md) => docToMarkdown(markdownToDoc(md));

describe('document markdown', () => {
  it('keeps every kind of block through the editor', () => {
    const md = [
      '# Title',
      '',
      '## Section',
      '',
      '###### Deep heading',
      '',
      'Some **bold**, *italic*, __underlined__, ~~struck~~, `code` and ||hidden|| text.',
      '',
      '> A quote',
      '> over lines',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      '- [ ] to do',
      '- [x] done',
      '',
      '---',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '| Name | Count |',
      '| :--- | ---: |',
      '| a | 1 |',
      '| **b** | 2 |',
      '',
      '[a link](https://example.com) and ![a picture](https://media.example/uploads/x.bin#v=1&k=abc&t=image/png&s=3)',
    ].join('\n');
    expect(roundTrip(md)).toBe(md);
  });

  it('reads what it writes the same way (a second save changes nothing)', () => {
    const odd = 'Under_scores and a | pipe, a *star* and 1. not a list\n\nline one\\\nline two';
    const once = roundTrip(odd);
    expect(roundTrip(once)).toBe(once);
    expect(markdownToDoc(once).textContent).toBe(markdownToDoc(odd).textContent);
  });

  it('reads underline and bold apart, as messages do', () => {
    const doc = markdownToDoc('__u__ **b**');
    const marks = [];
    doc.descendants((node) => { if (node.isText) marks.push(node.marks.map((m) => m.type.name)); });
    expect(marks).toEqual([['underline'], [], ['strong']]);
  });

  it('nests lists and keeps checklist state', () => {
    const md = '- parent\n  - child\n    - [x] grandchild';
    expect(roundTrip(md)).toBe(md);
  });

  it('starts an empty document with one paragraph', () => {
    expect(markdownToDoc('').childCount).toBe(1);
    expect(docToMarkdown(markdownToDoc(''))).toBe('');
  });

  it('keeps raw HTML as text', () => {
    expect(markdownToDoc('<b>hi</b>').textContent).toBe('<b>hi</b>');
  });
});

describe('documentExcerpt', () => {
  it('is the start of the text without markup', () => {
    expect(documentExcerpt('# Hello\n\nSome **bold** [link](https://x.y) ![img](https://a/b.png)\n\n- item')).toBe('Hello Some bold link item');
  });

  it('cuts long text with an ellipsis', () => {
    const text = documentExcerpt('word '.repeat(100), 20);
    expect(text.length).toBeLessThanOrEqual(20);
    expect(text.endsWith('…')).toBe(true);
  });
});
