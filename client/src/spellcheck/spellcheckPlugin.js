import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { spellcheckLanguage } from '../utils/spellcheck';
import { misspelled, subscribeChecker } from './checker';
import { wordsIn } from './words';

// Our spellcheck's red underlines in a ProseMirror editor (the message box and the document
// editor): every paragraph's words (spellcheck/words.js) are asked of the checker a moment
// after a change, and the misspelled ones decorated. While our checker is the one checking,
// the editor turns the browser's off (`spellcheck="false"`), so there's one set of underlines.
// Code (blocks, and text marked as code), links and chips (mentions, emoji) are skipped, and
// so is the word being typed until the cursor leaves it. `skipRanges(doc)` -> [[from, to]]
// leaves out more (the message box's markdown code).

export const spellcheckKey = new PluginKey('spellcheck');
const views = new WeakMap(); // editor element -> view
const GAP = '￼';

const skippedMark = (mark) => mark.type.spec.code || mark.type.name === 'link' || mark.type.name === 'code';

// [{ word, from, to }] in document positions.
export function docWords(doc, skip = []) {
  const found = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    let text = '';
    const at = []; // text index -> document position
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText && !child.marks.some(skippedMark)) {
        text += child.text;
        for (let i = 0; i < child.text.length; i += 1) at.push(start + i);
      } else {
        const size = child.isText ? child.text.length : 1;
        text += GAP.repeat(size);
        for (let i = 0; i < size; i += 1) at.push(start + i);
      }
    });
    for (const w of wordsIn(text)) {
      const from = at[w.from];
      const to = at[w.to - 1] + 1;
      if (!skip.some(([a, b]) => from < b && to > a)) found.push({ word: w.word, from, to });
    }
    return false;
  });
  return found;
}

function underlines(state, skipRanges, previous) {
  const { empty, head } = state.selection;
  const decorations = [];
  for (const w of docWords(state.doc, skipRanges?.(state.doc) ?? [])) {
    if (!misspelled(w.word)) continue;
    // Still being typed: not until it's finished (unless it was already underlined).
    if (empty && head === w.to && !previous.find(w.from, w.to).some((d) => d.spec.word === w.word)) continue;
    decorations.push(Decoration.inline(w.from, w.to, { class: 'spelling-error' }, { word: w.word }));
  }
  return DecorationSet.create(state.doc, decorations);
}

const sameSet = (a, b) => {
  const x = a.find();
  const y = b.find();
  return x.length === y.length && x.every((d, i) => d.from === y[i].from && d.to === y[i].to);
};

export function spellcheckPlugin({ skipRanges } = {}) {
  return new Plugin({
    key: spellcheckKey,
    state: {
      init: () => ({ set: DecorationSet.empty, ours: Boolean(spellcheckLanguage()) }),
      apply(tr, value) {
        const next = tr.getMeta(spellcheckKey);
        if (next) return next;
        return tr.docChanged ? { ...value, set: value.set.map(tr.mapping, tr.doc) } : value;
      },
    },
    props: {
      decorations: (state) => spellcheckKey.getState(state).set,
      attributes: (state) => (spellcheckKey.getState(state).ours ? { spellcheck: 'false' } : {}),
    },
    view(view) {
      views.set(view.dom, view);
      let timer = null;
      const scan = () => {
        timer = null;
        if (view.isDestroyed) return;
        const current = spellcheckKey.getState(view.state);
        const next = { set: underlines(view.state, skipRanges, current.set), ours: Boolean(spellcheckLanguage()) };
        if (next.ours === current.ours && sameSet(next.set, current.set)) return;
        view.dispatch(view.state.tr.setMeta(spellcheckKey, next).setMeta('addToHistory', false));
      };
      const schedule = (delay) => {
        clearTimeout(timer);
        timer = setTimeout(scan, delay);
      };
      const stop = subscribeChecker(() => schedule(0));
      schedule(0);
      return {
        update(v, prev) {
          if (v.state.doc !== prev.doc || !v.state.selection.eq(prev.selection)) schedule(250);
        },
        destroy() {
          clearTimeout(timer);
          stop();
          views.delete(view.dom);
        },
      };
    },
  });
}

// The spellchecked editor `element` is in, or null.
export function spellcheckViewOf(element) {
  const dom = element?.closest?.('.ProseMirror');
  return (dom && views.get(dom)) || null;
}

// The word at document position `pos` in `view`: { word, from, to }, or null.
export function wordAtPos(view, pos) {
  return docWords(view.state.doc).find((w) => w.from <= pos && pos <= w.to) ?? null;
}

// Puts `replacement` in place of the word at [from, to].
export function replaceWord(view, { from, to }, replacement) {
  view.dispatch(view.state.tr.insertText(replacement, from, to).scrollIntoView());
  view.focus();
}
