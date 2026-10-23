import { MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown';
import { schema } from './documentSchema.js';

// The editor's ProseMirror document -> its markdown (documentMarkdown.js parses it back). Also
// loaded by the server (server/documentCollab.js), which writes out live-edited documents
// itself: so this file and documentSchema.js import only packages and each other, with `.js`
// on every path (plain Node needs it).

const base = defaultMarkdownSerializer.nodes;

function bulletPrefix(item) {
  if (item.attrs.checked == null) return '- ';
  return item.attrs.checked ? '- [x] ' : '- [ ] ';
}

// A table cell's content as one line of markdown.
function cellMarkdown(cell) {
  return serializer
    .serialize(schema.node('doc', null, [schema.node('paragraph', null, cell.content)]))
    .replace(/\\\n/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}

const ALIGN_RULE = { left: ':---', center: ':---:', right: '---:' };

const serializer = new MarkdownSerializer({
  ...base,
  code_block(state, node) {
    const backticks = node.textContent.match(/`{3,}/gm);
    const fence = backticks ? `${backticks.sort().slice(-1)[0]}\`` : '```';
    state.write(`${fence}${node.attrs.language || ''}\n`);
    state.text(node.textContent, false);
    state.ensureNewLine();
    state.write(fence);
    state.closeBlock(node);
  },
  horizontal_rule(state, node) {
    state.write('---');
    state.closeBlock(node);
  },
  bullet_list(state, node) {
    state.renderList(node, '  ', (i) => bulletPrefix(node.child(i)));
  },
  table(state, node) {
    const rows = [];
    node.forEach((row) => {
      const cells = [];
      row.forEach((cell) => cells.push(cellMarkdown(cell)));
      rows.push(cells);
    });
    const width = Math.max(...rows.map((r) => r.length));
    const aligns = [];
    node.firstChild.forEach((cell) => aligns.push(cell.attrs.align));
    const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    const lines = [
      line(rows[0]),
      `| ${Array.from({ length: width }, (_, i) => ALIGN_RULE[aligns[i]] ?? '---').join(' | ')} |`,
      ...rows.slice(1).map(line),
    ];
    lines.forEach((text, i) => {
      if (i) state.ensureNewLine();
      state.write(text);
    });
    state.closeBlock(node);
  },
}, {
  ...defaultMarkdownSerializer.marks,
  underline: { open: '__', close: '__', mixable: true, expelEnclosingWhitespace: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  spoiler: { open: '||', close: '||', mixable: true, expelEnclosingWhitespace: true },
}, {
  // `|` starts spoilers and splits table cells, so a typed one is escaped.
  escapeExtraCharacters: /\|/g,
});

export function docToMarkdown(doc) {
  return serializer.serialize(doc).replace(/\s+$/, '');
}
