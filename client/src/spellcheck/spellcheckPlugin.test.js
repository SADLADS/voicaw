// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { createEditorState, nodeViews } from '../documents/editorSetup';
import { markdownToDoc } from '../documents/documentMarkdown';
import { docWords, replaceWord, spellcheckViewOf, wordAtPos } from './spellcheckPlugin';

const WRONG = new Set(['wrold', 'teh', 'codde', 'linkk']);
let ours = 'en-GB';
vi.mock('./checker', () => ({
  misspelled: (word) => (ours ? WRONG.has(word) : false),
  subscribeChecker: () => () => {},
}));
vi.mock('../utils/spellcheck', () => ({ spellcheckLanguage: () => ours }));

let view;
afterEach(() => {
  view?.destroy();
  ours = 'en-GB';
});

function editor(markdown) {
  const mount = document.createElement('div');
  document.body.append(mount);
  view = new EditorView(mount, { state: createEditorState(markdownToDoc(markdown)), nodeViews });
  return view;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 10); });
const underlined = () => [...view.dom.querySelectorAll('.spelling-error')].map((el) => el.textContent);

describe('spellcheck underlines in an editor', () => {
  it('finds the words of every paragraph, leaving out code and links', () => {
    editor('# Hello wrold\n\nSome `codde` and [linkk](https://x.test) teh end\n\n```\ncodde\n```');
    expect(docWords(view.state.doc).map((w) => w.word)).toEqual(['Hello', 'wrold', 'Some', 'and', 'teh', 'end']);
    const [, wrold] = docWords(view.state.doc);
    expect(view.state.doc.textBetween(wrold.from, wrold.to)).toBe('wrold');
  });

  it('underlines misspelled words, and turns off the browser checker', async () => {
    editor('Hello wrold, teh end');
    await settle();
    expect(underlined()).toEqual(['wrold', 'teh']);
    expect(view.dom.getAttribute('spellcheck')).toBe('false');
    expect(spellcheckViewOf(view.dom.querySelector('.spelling-error'))).toBe(view);
  });

  it("leaves the browser's checker on when ours isn't the one checking", async () => {
    ours = null;
    editor('Hello wrold');
    await settle();
    expect(underlined()).toEqual([]);
    expect(view.dom.hasAttribute('spellcheck')).toBe(false);
  });

  it('waits for a word being typed to be finished', async () => {
    editor('Hello');
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    view.dispatch(view.state.tr.insertText(' teh'));
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(underlined()).toEqual([]);
    view.dispatch(view.state.tr.insertText(' '));
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(underlined()).toEqual(['teh']);
  });

  it('finds the word right-clicked, and replaces it with a suggestion', async () => {
    editor('Hello wrold');
    await settle();
    const found = wordAtPos(view, 9);
    expect(found).toEqual({ word: 'wrold', from: 7, to: 12 });
    replaceWord(view, found, 'world');
    expect(view.state.doc.textContent).toBe('Hello world');
    expect(wordAtPos(view, 6).word).toBe('Hello'); // just after it counts too
  });
});
