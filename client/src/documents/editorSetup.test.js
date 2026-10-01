// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { createEditorState, insertTable, nodeViews, setLink, toggleBold, toggleChecklist, toggleQuote } from './editorSetup';
import { docToMarkdown, markdownToDoc } from './documentMarkdown';

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
