import { schema } from './documentSchema';
import { parseDocumentTree } from './documentText';

// A document's markdown <-> the editor's ProseMirror document. Parsing goes through the same
// remark pipeline as the page (documentText.js), so what the editor shows is what the page
// will; anything the schema can't hold (raw HTML, footnotes, link definitions) is kept as the
// text it was typed as.

// ---- markdown -> ProseMirror ----

export function markdownToDoc(markdown) {
  const source = markdown ?? '';
  const tree = parseDocumentTree(source);
  const blocks = toBlocks(tree.children, source);
  return schema.node('doc', null, blocks.length ? blocks : [schema.node('paragraph')]);
}

const sourceOf = (node, source) => (node.position
  ? source.slice(node.position.start.offset, node.position.end.offset)
  : '');

function toBlocks(children, source) {
  const blocks = [];
  for (const node of children) {
    const block = toBlock(node, source);
    if (Array.isArray(block)) blocks.push(...block);
    else if (block) blocks.push(block);
  }
  return blocks;
}

function paragraphOf(inlines) {
  return schema.node('paragraph', null, inlines);
}

function toBlock(node, source) {
  const { nodes } = schema;
  switch (node.type) {
    case 'paragraph':
      return paragraphOf(toInlines(node.children, source));
    case 'heading':
      return nodes.heading.create({ level: node.depth }, toInlines(node.children, source));
    case 'thematicBreak':
      return nodes.horizontal_rule.create();
    case 'blockquote': {
      const inner = toBlocks(node.children, source);
      return nodes.blockquote.create(null, inner.length ? inner : [paragraphOf([])]);
    }
    case 'code':
      return nodes.code_block.create({ language: node.lang ?? '' }, node.value ? schema.text(node.value) : null);
    case 'list': {
      const type = node.ordered ? nodes.ordered_list : nodes.bullet_list;
      const attrs = node.ordered ? { order: node.start ?? 1, tight: !node.spread } : { tight: !node.spread };
      const items = node.children.map((item) => {
        const inner = toBlocks(item.children, source);
        if (inner[0]?.type !== nodes.paragraph) inner.unshift(paragraphOf([]));
        return nodes.list_item.create({ checked: item.checked ?? null }, inner);
      });
      return type.create(attrs, items);
    }
    case 'table': {
      const align = node.align ?? [];
      const rows = node.children.map((row, r) => nodes.table_row.create(null, row.children.map((cell, c) => (
        (r === 0 ? nodes.table_header : nodes.table_cell).create({ align: align[c] ?? null }, toInlines(cell.children, source))
      ))));
      return rows.length ? nodes.table.create(null, rows) : null;
    }
    case 'html':
    case 'definition':
    case 'footnoteDefinition':
      return paragraphOf(textNodes(sourceOf(node, source), []));
    default:
      return node.children ? toBlocks(node.children, source) : null;
  }
}

const textNodes = (text, marks) => (text ? [schema.text(text, marks)] : []);

function toInlines(children, source, marks = []) {
  const { marks: m, nodes } = schema;
  const out = [];
  const add = (node) => (Array.isArray(node) ? out.push(...node) : node && out.push(node));
  const withMark = (mark, node) => add(toInlines(node.children, source, mark.addToSet(marks)));
  for (const node of children ?? []) {
    switch (node.type) {
      case 'text':
        add(textNodes(node.value, marks));
        break;
      case 'emphasis':
        withMark(m.em.create(), node);
        break;
      case 'strong':
        // remarkDocument marks `__text__` as underline.
        withMark(node.data?.hName === 'u' ? m.underline.create() : m.strong.create(), node);
        break;
      case 'delete':
        withMark(m.strike.create(), node);
        break;
      case 'spoiler':
        withMark(m.spoiler.create(), node);
        break;
      case 'inlineCode':
        add(textNodes(node.value, m.code.create().addToSet(marks)));
        break;
      case 'link':
        withMark(m.link.create({ href: node.url, title: node.title ?? null }), node);
        break;
      case 'image':
        add(nodes.image.create({ src: node.url, alt: node.alt ?? '', title: node.title ?? null }));
        break;
      case 'break':
        add(nodes.hard_break.create());
        break;
      default:
        // html, references, footnote calls: as typed.
        add(node.children ? toInlines(node.children, source, marks) : textNodes(node.value ?? sourceOf(node, source), marks));
    }
  }
  return out;
}

export { docToMarkdown } from './documentSerializer.js';
