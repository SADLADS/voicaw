import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands, exitCode, lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { goToNextCell, tableEditing } from 'prosemirror-tables';
import { schema } from './documentSchema';
import { parseAttachmentUrl } from '../services/attachmentCrypto';
import { t } from '../i18n';
import { getCachedAttachment, loadDecryptedAttachment } from '../services/attachmentCache';
import { spellcheckPlugin } from '../spellcheck/spellcheckPlugin';
import { galleryItemFromUrl, galleryItemRef } from '../utils/imageGallery';

// The document editor's behaviour (DocumentEditor draws it): Word-like keyboard shortcuts
// and toolbar commands, plus markdown typed as you'd type it in a message (`# `, `- `, `**x**`)
// turning into the formatting at once.

const { nodes, marks } = schema;

// ---- Commands (for the toolbar and keys) ----

export const toggleBold = toggleMark(marks.strong);
export const toggleItalic = toggleMark(marks.em);
export const toggleUnderline = toggleMark(marks.underline);
export const toggleStrike = toggleMark(marks.strike);
export const toggleCode = toggleMark(marks.code);
export const toggleSpoiler = toggleMark(marks.spoiler);
export const makeParagraph = setBlockType(nodes.paragraph);
export const makeHeading = (level) => setBlockType(nodes.heading, { level });
export const makeCodeBlock = setBlockType(nodes.code_block);
export const bulletList = wrapInList(nodes.bullet_list);
export const orderedList = wrapInList(nodes.ordered_list);
export { undo, redo };

const insertHardBreak = chainCommands(exitCode, (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
  return true;
});

// Wraps the selection in a quote, or takes it out of one.
export function toggleQuote(state, dispatch) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === nodes.blockquote) return lift(state, dispatch);
  }
  return wrapIn(nodes.blockquote)(state, dispatch);
}

// List items in the selection (and the one it's in).
function selectedListItems(state) {
  const { $from, from, to } = state.selection;
  const found = [];
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === nodes.list_item) {
      found.push({ node: $from.node(d), pos: $from.before(d) });
      break;
    }
  }
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === nodes.list_item && !found.some((f) => f.pos === pos)) found.push({ node, pos });
  });
  return found;
}

// Makes the selected list items a checklist (or ordinary items again); outside a list, starts one.
export function toggleChecklist(state, dispatch) {
  const items = selectedListItems(state);
  if (items.length) {
    const checked = items[0].node.attrs.checked == null ? false : null;
    if (dispatch) {
      const tr = state.tr;
      for (const { node, pos } of items) tr.setNodeMarkup(pos, null, { ...node.attrs, checked });
      dispatch(tr);
    }
    return true;
  }
  return bulletList(state, dispatch && ((tr) => {
    const { from, to } = tr.selection;
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === nodes.list_item) tr.setNodeMarkup(pos, null, { ...node.attrs, checked: false });
    });
    dispatch(tr);
  }));
}

export function insertRule(state, dispatch) {
  dispatch?.(state.tr.replaceSelectionWith(nodes.horizontal_rule.create()).scrollIntoView());
  return true;
}

// A table with a header row: `rows` × `cols` (rows counts the header).
export function insertTable(rows = 3, cols = 3) {
  return (state, dispatch) => {
    const row = (cell) => nodes.table_row.create(null, Array.from({ length: cols }, () => cell.create()));
    const table = nodes.table.create(null, [row(nodes.table_header), ...Array.from({ length: rows - 1 }, () => row(nodes.table_cell))]);
    if (!dispatch) return true;
    const tr = state.tr.replaceSelectionWith(table);
    // Carry on typing in its first cell.
    let cell = null;
    tr.doc.nodesBetween(tr.mapping.map(state.selection.from, -1), tr.doc.content.size, (node, pos) => {
      if (cell == null && node.type === nodes.table_header) cell = pos + 1;
      return cell == null;
    });
    if (cell != null) tr.setSelection(TextSelection.create(tr.doc, cell));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function insertImage(view, src, alt) {
  const { state } = view;
  view.dispatch(state.tr.replaceSelectionWith(nodes.image.create({ src, alt })).scrollIntoView());
}

// A link on the selection (`href`), or the link's text inserted where there's no selection;
// null `href` takes the link off.
export function setLink(href) {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (!dispatch) return true;
    const tr = state.tr;
    if (!href) {
      dispatch(tr.removeMark(from, to, marks.link));
      return true;
    }
    const mark = marks.link.create({ href });
    if (empty) tr.insert(from, schema.text(href, [mark]));
    else tr.addMark(from, to, mark);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

// ---- What the toolbar shows as active ----

export function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return Boolean(type.isInSet(state.storedMarks || $from.marks()));
  return state.doc.rangeHasMark(from, to, type);
}

export const linkActive = (state) => markActive(state, marks.link);

// 'paragraph', 'h1'…'h6', 'code' or null (several kinds selected).
export function blockStyle(state) {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to)) return null;
  const parent = $from.parent;
  if (parent.type === nodes.heading) return `h${parent.attrs.level}`;
  if (parent.type === nodes.code_block) return 'code';
  return parent.type === nodes.paragraph ? 'paragraph' : null;
}

// The innermost list the selection is in: 'bullet', 'ordered', 'check' or null.
export function listKind(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === nodes.list_item && node.attrs.checked != null) return 'check';
    if (node.type === nodes.bullet_list) return 'bullet';
    if (node.type === nodes.ordered_list) return 'ordered';
  }
  return null;
}

export function inQuote(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === nodes.blockquote) return true;
  return false;
}

// ---- Typing markdown ----

// `**text**` and the like become the mark once the closing marker is typed. `pattern`'s
// first group is the text, ending where the match does; the opening marker is the `open`
// characters just before it.
function markRule(pattern, type, open) {
  return new InputRule(pattern, (state, match, start, end) => {
    const [whole, text] = match;
    // The match ends with the character being typed, which isn't in the document yet.
    const closeLength = whole.length - whole.lastIndexOf(text) - text.length;
    const textEnd = end - (closeLength - 1);
    const textStart = textEnd - text.length;
    const markerStart = textStart - open;
    const tr = state.tr;
    tr.delete(textEnd, end);
    tr.delete(markerStart, textStart);
    tr.addMark(markerStart, markerStart + text.length, type.create());
    tr.removeStoredMark(type);
    return tr;
  });
}

const rules = inputRules({
  rules: [
    wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
    wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, nodes.ordered_list, (match) => ({ order: Number(match[1]) }),
      (match, node) => node.childCount + node.attrs.order === Number(match[1])),
    textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({ level: match[1].length })),
    textblockTypeInputRule(/^```([\w-]*)\s$/, nodes.code_block, (match) => ({ language: match[1] })),
    // `[ ] ` or `[x] ` starting a list item makes it a checklist item.
    new InputRule(/^\[([ xX]?)\]\s$/, (state, match, start, end) => {
      const $start = state.doc.resolve(start);
      const item = $start.node(-1);
      if (item?.type !== nodes.list_item || $start.index(-1) !== 0) return null;
      return state.tr.delete(start, end)
        .setNodeMarkup($start.before(-1), null, { ...item.attrs, checked: match[1].toLowerCase() === 'x' });
    }),
    new InputRule(/^(?:---|\*\*\*|___)$/, (state, match, start) => {
      const $start = state.doc.resolve(start);
      if ($start.parent.type !== nodes.paragraph || $start.parent.content.size !== match[0].length - 1) return null;
      // The rule, and a paragraph after it to carry on in.
      const tr = state.tr.replaceWith($start.before(), $start.after(), [nodes.horizontal_rule.create(), nodes.paragraph.create()]);
      return tr.setSelection(TextSelection.create(tr.doc, $start.before() + 2));
    }),
    markRule(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, marks.strong, 2),
    markRule(/__([^_\s](?:[^_]*[^_\s])?)__$/, marks.underline, 2),
    markRule(/(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, marks.em, 1),
    markRule(/~~([^~\s](?:[^~]*[^~\s])?)~~$/, marks.strike, 2),
    markRule(/\|\|([^|\s](?:[^|]*[^|\s])?)\|\|$/, marks.spoiler, 2),
    markRule(/`([^`\s](?:[^`]*[^`\s])?)`$/, marks.code, 1),
  ],
});

// ---- Keys ----

const keys = keymap({
  'Mod-z': undo,
  'Shift-Mod-z': redo,
  'Mod-y': redo,
  Backspace: undoInputRule,
  'Mod-b': toggleBold,
  'Mod-i': toggleItalic,
  'Mod-u': toggleUnderline,
  'Shift-Mod-x': toggleStrike,
  'Mod-e': toggleCode,
  'Shift-Enter': insertHardBreak,
  'Mod-Enter': insertHardBreak,
  'Mod-Alt-0': makeParagraph,
  'Mod-Alt-1': makeHeading(1),
  'Mod-Alt-2': makeHeading(2),
  'Mod-Alt-3': makeHeading(3),
  'Shift-Mod-7': orderedList,
  'Shift-Mod-8': bulletList,
  'Shift-Mod-9': toggleChecklist,
  Enter: splitListItem(nodes.list_item),
  Tab: chainCommands(goToNextCell(1), sinkListItem(nodes.list_item)),
  'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(nodes.list_item)),
  'Mod-[': liftListItem(nodes.list_item),
  'Mod-]': sinkListItem(nodes.list_item),
});

// "Start writing…" in an empty document.
function placeholder(text) {
  return new Plugin({
    props: {
      decorations(state) {
        const { doc } = state;
        const only = doc.childCount === 1 && doc.firstChild;
        if (!only || only.type !== nodes.paragraph || only.content.size) return null;
        return DecorationSet.create(doc, [Decoration.node(0, only.nodeSize, { class: 'doc-editor-empty', 'data-placeholder': text })]);
      },
    },
  });
}

export function createEditorState(doc, { placeholderText = t('documents.editor.startWriting'), extraPlugins = [] } = {}) {
  return EditorState.create({
    doc,
    plugins: [
      rules,
      keys,
      keymap(baseKeymap),
      history(),
      dropCursor(),
      gapCursor(),
      tableEditing(),
      placeholder(placeholderText),
      spellcheckPlugin(),
      ...extraPlugins,
    ],
  });
}

// ---- Node views ----

// A checklist item: a real checkbox before its text (click to tick it).
class ListItemView {
  constructor(node, view, getPos) {
    this.node = node;
    this.dom = document.createElement('li');
    this.checkbox = document.createElement('input');
    this.checkbox.type = 'checkbox';
    this.checkbox.contentEditable = 'false';
    this.checkbox.className = 'doc-editor-check';
    this.checkbox.addEventListener('mousedown', (e) => e.preventDefault());
    this.checkbox.addEventListener('click', () => {
      const pos = getPos();
      if (pos == null) return;
      view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, checked: !this.node.attrs.checked }));
    });
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'doc-editor-item-text';
    this.dom.append(this.checkbox, this.contentDOM);
    this.render();
  }

  render() {
    const { checked } = this.node.attrs;
    this.dom.className = checked == null ? '' : `doc-editor-task${checked ? ' checked' : ''}`;
    this.checkbox.hidden = checked == null;
    this.checkbox.checked = Boolean(checked);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(mutation) {
    return mutation.target === this.checkbox || mutation.type === 'attributes';
  }
}

// An image: an encrypted upload is shown decrypted; other sites' images without a referrer.
class ImageView {
  constructor(node) {
    this.dom = document.createElement('img');
    this.dom.className = 'doc-editor-image';
    this.dom.alt = node.attrs.alt;
    this.dom.draggable = true;
    // Its menu (copy, save...) on right click (PageMenus) or a long press (useImageHold).
    this.dom.dataset.galleryItem = '';
    galleryItemRef(galleryItemFromUrl(node.attrs.src, node.attrs.alt || t('documents.editor.imageName')))(this.dom);
    const meta = parseAttachmentUrl(node.attrs.src);
    if (!meta) {
      this.dom.referrerPolicy = 'no-referrer';
      this.dom.src = node.attrs.src;
      return;
    }
    if (meta.width && meta.height) this.dom.style.aspectRatio = `${meta.width} / ${meta.height}`;
    const cached = getCachedAttachment(node.attrs.src);
    if (cached) {
      this.dom.src = cached;
      return;
    }
    this.dom.classList.add('loading');
    loadDecryptedAttachment(node.attrs.src, meta)
      .then((src) => {
        this.dom.src = src;
        this.dom.classList.remove('loading');
      })
      .catch(() => this.dom.classList.add('failed'));
  }

  stopEvent() {
    return false;
  }
}

export const nodeViews = {
  list_item: (node, view, getPos) => new ListItemView(node, view, getPos),
  image: (node) => new ImageView(node),
};
