import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { displayName } from '../utils/profiles';
import { t } from '../i18n';

// The other editors' cursors and selections in a document being edited live
// (documentCollab.js), each person in one of COLOURS colours (`--vc-collab-<n>`), a caret with
// their name over it and their selection shaded. Positions are in this editor's document and
// follow every change made here; documentCollab.js puts in new ones (`setCursors`), already
// brought up to this document.

export const COLOURS = 6;
export const colourOf = (userId) => (Number(userId) % COLOURS) + 1;

const key = new PluginKey('collabCursors');

const clamp = (pos, doc) => Math.max(0, Math.min(pos, doc.content.size));

function caret(cursor) {
  const dom = document.createElement('span');
  dom.className = `collab-caret collab-colour-${colourOf(cursor.userId)}`;
  const label = document.createElement('span');
  label.className = 'collab-caret-name';
  label.textContent = displayName(cursor.userId, t('documents.deletedUser'));
  dom.append(label);
  return dom;
}

function decorations(doc, cursors) {
  const list = [];
  for (const [clientID, cursor] of cursors) {
    const anchor = clamp(cursor.anchor, doc);
    const head = clamp(cursor.head, doc);
    const colour = colourOf(cursor.userId);
    if (anchor !== head) {
      list.push(Decoration.inline(Math.min(anchor, head), Math.max(anchor, head), { class: `collab-selection collab-colour-${colour}` }));
    }
    list.push(Decoration.widget(head, () => caret(cursor), {
      key: `${clientID}:${cursor.userId}:${displayName(cursor.userId)}`,
      side: -1,
      ignoreSelection: true,
    }));
  }
  return DecorationSet.create(doc, list);
}

// State: { cursors: Map clientID -> { userId, anchor, head }, set: DecorationSet }.
export function collabCursorsPlugin() {
  return new Plugin({
    key,
    state: {
      init: (_, state) => ({ cursors: new Map(), set: DecorationSet.create(state.doc, []) }),
      apply(tr, value, _old, state) {
        const replaced = tr.getMeta(key);
        if (replaced) return { cursors: replaced, set: decorations(state.doc, replaced) };
        if (!tr.docChanged) return value;
        const cursors = new Map();
        for (const [clientID, cursor] of value.cursors) {
          cursors.set(clientID, { ...cursor, anchor: tr.mapping.map(cursor.anchor), head: tr.mapping.map(cursor.head) });
        }
        return { cursors, set: decorations(state.doc, cursors) };
      },
    },
    props: {
      decorations: (state) => key.getState(state).set,
    },
  });
}

export const getCursors = (state) => key.getState(state)?.cursors ?? new Map();

// A transaction giving the cursors (positions in `state`'s document) in place of the old ones.
export const setCursors = (state, cursors) => state.tr.setMeta(key, cursors);
