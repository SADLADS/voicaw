// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { createEditorState, insertTable, nodeViews, setLink, toggleBold, toggleChecklist, toggleQuote } from './editorSetup';
import { docToMarkdown, markdownToDoc } from './documentMarkdown';
import { safeHref, schema } from './documentSchema';
import { DOMParser } from 'prosemirror-model';
import { setPrivacyPref } from '../utils/privacy';

let view;
afterEach(() => view?.destroy());

function editor(markdown = '') {
  const mount = document.createElement('div');
  document.body.append(mount);
  view = new EditorView(mount, { state: createEditorState(markdownToDoc(markdown)), nodeViews });
  return view;
}

// Types `text` a character at a time, as the browser would (input rules see each one).
function type(text) {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, char, () => view.state.tr.insertText(char, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

const markdown = () => docToMarkdown(view.state.doc);
const selectAll = () => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1)));
const run = (command) => command(view.state, view.dispatch, view);

describe('typing markdown in the document editor', () => {
  it('turns block markers into headings, lists, quotes and code', () => {
    editor();
    type('## Heading');
    expect(markdown()).toBe('## Heading');

    editor();
    type('- item');
    expect(markdown()).toBe('- item');

    editor();
    type('1. first');
    expect(markdown()).toBe('1. first');

    editor();
    type('> quoted');
    expect(markdown()).toBe('> quoted');

    editor();
    type('```js ');
    type('x');
    expect(markdown()).toBe('```js\nx\n```');
  });

  it('makes a checklist item from [ ] in a list', () => {
    editor();
    type('- [ ] buy milk');
    expect(markdown()).toBe('- [ ] buy milk');
    editor();
    type('- [x] done');
    expect(markdown()).toBe('- [x] done');
  });

  it('turns closing markers into formatting, keeping what came before', () => {
    editor();
    type('a **bold** b *it* c __u__ d ~~s~~ e `c`');
    expect(markdown()).toBe('a **bold** b *it* c __u__ d ~~s~~ e `c`');
    const marks = [];
    view.state.doc.descendants((n) => { if (n.isText) marks.push([n.text, n.marks.map((m) => m.type.name).join()]); });
    expect(marks).toEqual([
      ['a ', ''], ['bold', 'strong'], [' b ', ''], ['it', 'em'], [' c ', ''], ['u', 'underline'],
      [' d ', ''], ['s', 'strike'], [' e ', ''], ['c', 'code'],
    ]);
  });

  it('makes a rule from --- and carries on below it', () => {
    editor();
    type('---');
    type('after');
    expect(markdown()).toBe('---\n\nafter');
  });
});

describe('document editor commands', () => {
  it('bolds the selection', () => {
    editor('hello');
    selectAll();
    run(toggleBold);
    expect(markdown()).toBe('**hello**');
  });

  it('toggles a checklist on and off', () => {
    editor('one');
    run(toggleChecklist);
    expect(markdown()).toBe('- [ ] one');
    run(toggleChecklist);
    expect(markdown()).toBe('- one');
  });

  it('quotes and unquotes', () => {
    editor('said');
    run(toggleQuote);
    expect(markdown()).toBe('> said');
    run(toggleQuote);
    expect(markdown()).toBe('said');
  });

  it('inserts a table with a header row', () => {
    editor('');
    run(insertTable(2, 2));
    expect(markdown()).toBe('|  |  |\n| --- | --- |\n|  |  |');
  });

  it('links the selection', () => {
    editor('site');
    selectAll();
    run(setLink('https://example.com'));
    expect(markdown()).toBe('[site](https://example.com)');
  });

  it('ticks a checklist item with its box', () => {
    editor('- [ ] task');
    const box = view.dom.querySelector('input[type="checkbox"]');
    expect(box.hidden).toBe(false);
    box.click();
    expect(markdown()).toBe('- [x] task');
  });
});

describe('link addresses', () => {
  it('only http(s), mailto and relative addresses are safe', () => {
    for (const ok of ['https://example.com', 'HTTP://x.y/a:b', 'mailto:a@b.c', '/dm/1', 'page#a:b', '?q=a:b']) expect(safeHref(ok)).toBe(ok);
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:x', 'data:text/html,x', 'vbscript:x', 'file:///etc', null, 42]) {
      expect(safeHref(bad)).toBeNull();
    }
  });

  it("draws a link to anything else without its address, keeping it in the markdown", () => {
    editor('[Reload to keep editing](javascript:alert(1)) and [fine](https://example.com)');
    const links = [...view.dom.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([null, 'https://example.com']);
    expect(links[0].textContent).toBe('Reload to keep editing');
    expect(markdown()).toContain('](javascript:alert');
  });

  it("won't paste one or add one from the toolbar", () => {
    editor('text');
    const slice = (html) => {
      const div = document.createElement('div');
      div.innerHTML = html;
      return DOMParser.fromSchema(schema).parse(div);
    };
    expect(slice('<a href="javascript:alert(1)">x</a>').firstChild.firstChild.marks).toEqual([]);
    expect(slice('<a href="https://example.com">x</a>').firstChild.firstChild.marks[0].attrs.href).toBe('https://example.com');
    selectAll();
    expect(run(setLink('javascript:alert(1)'))).toBe(false);
    expect(view.dom.querySelector('a')).toBeNull();
  });
});

describe("other sites' pictures in the editor", () => {
  afterEach(() => setPrivacyPref('linkPreviews', true));

  it('load at once by default, without a referrer', () => {
    editor('![a cat](https://pics.example/cat.png)');
    const img = view.dom.querySelector('img.doc-editor-image');
    expect(img.getAttribute('src')).toBe('https://pics.example/cat.png');
    expect(img.referrerPolicy).toBe('no-referrer');
  });

  it('wait for Show while "Show link previews" is off, so the site learns nothing first', () => {
    setPrivacyPref('linkPreviews', false);
    editor('![a dog](https://pics.example/dog.png)');
    expect(view.dom.querySelector('img.doc-editor-image')).toBeNull(); // (ProseMirror adds its own separator img)
    const box = view.dom.querySelector('.doc-editor-image-hidden');
    expect(box.textContent).toContain('pics.example');
    box.querySelector('button').click();
    const img = view.dom.querySelector('img.doc-editor-image');
    expect(img.getAttribute('src')).toBe('https://pics.example/dog.png');
    expect(docToMarkdown(view.state.doc)).toBe('![a dog](https://pics.example/dog.png)'); // the document unchanged

    // Shown once, it stays shown when drawn again.
    editor('![a dog](https://pics.example/dog.png)');
    expect(view.dom.querySelector('img.doc-editor-image')).not.toBeNull();
  });
});
