import { Schema } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

// The document editor's schema: what markdown (documents' flavour, see remarkDocument) can
// hold, and nothing more, so every document saves as markdown with nothing lost. Text
// colours, sizes and alignment aren't here on purpose: markdown has no way to keep them.

// A link's address if it's safe to put in the page: http(s), mailto, or relative (no scheme), as
// the read view's react-markdown allows; otherwise null. ProseMirror draws links itself, so
// nothing else stops a `javascript:` one running when it's clicked (security audit, 2026-11-18).
export function safeHref(href) {
  if (typeof href !== 'string') return null;
  const colon = href.indexOf(':');
  const firstOf = (chars) => Math.min(...[...chars].map((c) => (href.indexOf(c) === -1 ? Infinity : href.indexOf(c))));
  if (colon === -1 || colon > firstOf('/?#')) return href;
  return /^(https?|mailto)$/i.test(href.slice(0, colon)) ? href : null;
}

const table = tableNodes({
  tableGroup: 'block',
  // GFM table cells hold one line of text.
  cellContent: 'inline*',
  cellAttributes: {
    // A column's alignment ('left', 'center', 'right' or null), from the table's `:--:` row.
    align: {
      default: null,
      getFromDOM: (dom) => dom.style.textAlign || null,
      setDOMAttr: (value, attrs) => {
        if (value) attrs.style = `${attrs.style ?? ''}text-align: ${value};`;
      },
    },
  },
});

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    blockquote: {
      content: 'block+',
      group: 'block',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0],
    },
    code_block: {
      attrs: { language: { default: '' } },
      content: 'text*',
      marks: '',
      group: 'block',
      code: true,
      defining: true,
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: () => ['pre', ['code', 0]],
    },
    horizontal_rule: {
      group: 'block',
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['hr'],
    },
    bullet_list: {
      attrs: { tight: { default: true } },
      content: 'list_item+',
      group: 'block',
      parseDOM: [{ tag: 'ul' }],
      toDOM: () => ['ul', 0],
    },
    ordered_list: {
      attrs: { order: { default: 1 }, tight: { default: true } },
      content: 'list_item+',
      group: 'block',
      parseDOM: [{ tag: 'ol', getAttrs: (dom) => ({ order: dom.hasAttribute('start') ? Number(dom.getAttribute('start')) : 1 }) }],
      toDOM: (node) => (node.attrs.order === 1 ? ['ol', 0] : ['ol', { start: node.attrs.order }, 0]),
    },
    // `checked`: null for an ordinary item, true/false for a checklist's (`- [x]`).
    list_item: {
      attrs: { checked: { default: null } },
      content: 'paragraph block*',
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: (node) => ['li', node.attrs.checked == null ? {} : { 'data-checked': String(node.attrs.checked) }, 0],
    },
    text: { group: 'inline' },
    image: {
      inline: true,
      attrs: { src: {}, alt: { default: '' }, title: { default: null } },
      group: 'inline',
      draggable: true,
      parseDOM: [{ tag: 'img[src]', getAttrs: (dom) => ({ src: dom.getAttribute('src'), alt: dom.getAttribute('alt') ?? '', title: dom.getAttribute('title') }) }],
      toDOM: (node) => ['img', { src: node.attrs.src, alt: node.attrs.alt }],
    },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'],
    },
    ...table,
  },
  // In the order markdown nests them when they overlap (code innermost).
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      // (A pasted link to anything else is kept as its text; one already in a document, from its
      // markdown or a collaborator, is drawn without its address.)
      parseDOM: [{
        tag: 'a[href]',
        getAttrs: (dom) => (safeHref(dom.getAttribute('href')) ? { href: dom.getAttribute('href'), title: dom.getAttribute('title') } : false),
      }],
      toDOM: (mark) => ['a', { href: safeHref(mark.attrs.href), title: mark.attrs.title, rel: 'noreferrer noopener' }, 0],
    },
    em: {
      parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
      toDOM: () => ['em', 0],
    },
    strong: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight', getAttrs: (v) => /^(bold(er)?|[5-9]\d{2,})$/.test(v) && null }],
      toDOM: () => ['strong', 0],
    },
    underline: {
      parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
      toDOM: () => ['u', 0],
    },
    strike: {
      parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
      toDOM: () => ['s', 0],
    },
    spoiler: {
      parseDOM: [{ tag: 'span.spoiler' }],
      toDOM: () => ['span', { class: 'spoiler doc-editor-spoiler' }, 0],
    },
    code: {
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0],
    },
  },
});
