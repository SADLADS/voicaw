// Makes messages' markdown Discord's (a remark plugin, after remark-gfm):
// - Only Discord's syntax: tables, `---` rules, headings made by underlining (`===`), headings
//   past `###`, code made by indenting, task lists, footnotes and `[x]: url` definitions stay
//   as typed.
// - `__text__` is underline (CommonMark makes it bold); `**text**` stays bold.
// - `||text||` is a spoiler (hidden until clicked; MessageList's span component draws it).
// - Blank lines between blocks show, as many as were typed (markdown folds any number of them
//   into one paragraph break): each is an empty `.blank-line` paragraph, a line high (dms.css).
// - ``` makes a code block however it's typed: ```on one line```, in the middle of a line, or
//   closed at the end of the last line of code (CommonMark wants the closing ``` on its own line).
// Code, inline or in blocks, is left alone.

import { t } from '../i18n';

// micromark constructs (by name) that Discord doesn't have.
const DISABLED = [
  'codeIndented', 'thematicBreak', 'setextUnderline', 'definition',
  'table', 'tasklistCheck', 'gfmFootnoteCall', 'gfmPotentialFootnoteCall', 'gfmFootnoteDefinition',
];

export function remarkDiscord() {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ disable: { null: DISABLED } });
  return (tree, file) => {
    const source = String(file.value ?? '');
    transform(tree, source);
  };
}

// Documents (document channels) are full markdown: all of GFM (tables, task lists, rules,
// every heading level), with blank lines folded as usual. Only `__underline__` and
// `||spoilers||` are the app's own, as in messages. The document editor parses with this too
// (documents/documentMarkdown.js), so it and the page always agree.
export function remarkDocument() {
  return (tree, file) => {
    const source = String(file.value ?? '');
    transform(tree, source, { document: true });
  };
}

function transform(node, source, { document = false } = {}) {
  if (!node.children) return;
  if (!document && (node.type === 'root' || node.type === 'blockquote')) addBlankLines(node, source);
  node.children.forEach((child, i) => {
    // Discord's headings stop at ###: deeper ones are the text they were typed as.
    if (!document && child.type === 'heading' && child.depth > 3) {
      node.children[i] = {
        type: 'paragraph',
        children: [{ type: 'text', value: `${'#'.repeat(child.depth)} ` }, ...child.children],
        position: child.position,
      };
    }
    if (child.type === 'strong' && source[child.position?.start.offset] === '_') {
      child.data = { ...child.data, hName: 'u' };
    }
  });
  node.children.forEach((child) => transform(child, source, { document }));
  wrapSpoilers(node);
  if (!document) {
    closeCodeBlocks(node, source);
    if (FLOW.has(node.type)) splitCodeBlocks(node, source);
  }
}

// Where a code block can stand, so what a paragraph holds can be lifted out of it.
const FLOW = new Set(['root', 'blockquote', 'listItem']);

// A code block never closed on a line of its own, because its last line ends with ```: that's
// its end, not code.
function closeCodeBlocks(parent, source) {
  for (const child of parent.children) {
    if (child.type !== 'code' || !child.position) continue;
    const lastLine = source.slice(child.position.start.offset, child.position.end.offset).split('\n').pop();
    if (/^[\s>]*`{3,}\s*$/.test(lastLine)) continue;
    child.value = child.value.replace(/\s*`{3,}\s*$/, '');
  }
}

// To CommonMark, ``` on one line (or mid-line) is inline code. Each such span in a paragraph
// becomes a code block between what's left of the paragraph. Spans inside other formatting,
// such as a spoiler, stay inline.
function splitCodeBlocks(parent, source) {
  parent.children = parent.children.flatMap((child) => {
    if (child.type !== 'paragraph' || !child.children.some((n) => isTripleCode(n, source))) return [child];
    const blocks = [];
    let inline = [];
    const flush = () => {
      trimInline(inline);
      if (inline.length) blocks.push({ type: 'paragraph', children: inline });
      inline = [];
    };
    for (const n of child.children) {
      if (!isTripleCode(n, source)) {
        inline.push(n);
        continue;
      }
      flush();
      blocks.push({ type: 'code', lang: null, meta: null, value: codeBlockText(n, parent, source), position: n.position });
    }
    flush();
    return blocks;
  });
}

const isTripleCode = (node, source) => node.type === 'inlineCode' && node.value.trim() !== ''
  && source.startsWith('```', node.position?.start.offset);

// The span's own text: CommonMark turns its newlines into spaces. In a quote or a list the
// source's lines have prefixes, so there the spaces stay.
function codeBlockText(node, parent, source) {
  if (parent.type !== 'root') return node.value;
  const raw = source.slice(node.position.start.offset, node.position.end.offset);
  return raw.replace(/^`+/, '').replace(/`+$/, '').replace(/^\n|\n$/g, '');
}

// The whitespace left at the ends of a paragraph's pieces.
function trimInline(inline) {
  const first = inline[0];
  if (first?.type === 'text') first.value = first.value.trimStart();
  const last = inline[inline.length - 1];
  if (last?.type === 'text') last.value = last.value.trimEnd();
  for (const at of [inline.length - 1, 0]) {
    if (inline[at]?.type === 'text' && !inline[at].value) inline.splice(at, 1);
  }
}

// Between two blocks, every newline after the first is a blank line the sender typed.
function addBlankLines(parent, source) {
  const kids = [];
  parent.children.forEach((child, i) => {
    const prev = parent.children[i - 1];
    const from = prev?.position?.end.offset;
    const to = child.position?.start.offset;
    if (from != null && to != null) {
      const newlines = source.slice(from, to).split('\n').length - 1;
      for (let n = 1; n < newlines; n++) kids.push(blankLine());
    }
    kids.push(child);
  });
  parent.children = kids;
}

const blankLine = () => ({
  type: 'paragraph',
  children: [],
  data: { hProperties: { className: ['blank-line'] } },
});

// Wraps what's between each pair of `||` (in this node's own text children; they can have
// other formatting in between) in a spoiler.
function wrapSpoilers(parent) {
  const kids = parent.children;
  // Where to look for the next `||` from.
  let cursor = { index: 0, offset: 0 };
  for (;;) {
    const open = findMarker(kids, cursor.index, cursor.offset);
    if (!open) return;
    const close = findMarker(kids, open.index, open.offset + 2);
    if (!close) return;

    const openText = kids[open.index].value;
    const closeText = kids[close.index].value;
    const inner = open.index === close.index
      ? [text(openText.slice(open.offset + 2, close.offset))]
      : [
        text(openText.slice(open.offset + 2)),
        ...kids.slice(open.index + 1, close.index),
        text(closeText.slice(0, close.offset)),
      ];
    const content = inner.filter((n) => n.type !== 'text' || n.value);
    if (!content.length) {
      // `||||`: nothing to hide; carry on after it.
      cursor = { index: close.index, offset: close.offset + 2 };
      continue;
    }
    const before = text(openText.slice(0, open.offset));
    const after = text(closeText.slice(close.offset + 2));
    const spoiler = {
      type: 'spoiler',
      children: content,
      data: { hName: 'span', hProperties: { className: ['spoiler'] } },
    };
    const replacement = [before, spoiler, after].filter((n) => n.type !== 'text' || n.value);
    kids.splice(open.index, close.index - open.index + 1, ...replacement);
    cursor = { index: open.index + replacement.indexOf(spoiler) + 1, offset: 0 };
  }
}

// The first `||` in a text child at or after (index, offset).
function findMarker(kids, index, offset) {
  for (let i = index; i < kids.length; i++) {
    if (kids[i].type !== 'text') continue;
    const at = kids[i].value.indexOf('||', i === index ? offset : 0);
    if (at >= 0) return { index: i, offset: at };
  }
  return null;
}

const text = (value) => ({ type: 'text', value });

// For plain-text places (reply previews, notifications): a spoiler's text stays hidden.
export function hideSpoilers(value) {
  return value == null ? value : String(value).replace(/\|\|(?!\|)([\s\S]+?)\|\|/g, () => t('chat.message.hiddenSpoiler'));
}
