import { Schema, Slice } from 'prosemirror-model';
import { makePlaceholder, unescapeAltText } from '../utils/attachmentMarkup';
import { customEmojiUrl } from '../emoji/customEmoji';

// What the message editor holds, and its conversion to and from message text (the markdown
// the rest of the app sends and stores). Lines are paragraphs. Inline, besides text:
// - attachment: a draft attachment, shown as a chip; in text `![name](attachment:ID)`.
// - customEmoji: a custom emoji, shown as its image; in text `<:name:id>`.
// Unicode emoji stay text (the Twemoji font draws them), which keeps typing, autocorrect and
// copy/paste plain.

export const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }, { tag: 'div' }],
    },
    text: { group: 'inline' },
    attachment: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { id: {}, name: {} },
      toDOM: (node) => [
        'span',
        { class: 'editor-attachment', 'data-attachment-id': String(node.attrs.id), contenteditable: 'false' },
        `📎 ${node.attrs.name}`,
      ],
    },
    customEmoji: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { id: {}, name: {}, url: {} },
      toDOM: (node) => [
        'img',
        {
          class: 'emoji',
          src: node.attrs.url,
          alt: `:${node.attrs.name}:`,
          title: `:${node.attrs.name}:`,
          draggable: 'false',
        },
      ],
    },
  },
});

// Stands in for chips and custom emoji in caret-context text (one character each).
export const OBJECT_CHAR = '￼';
const leafText = () => OBJECT_CHAR;

function inlineToText(node) {
  if (node.isText) return node.text;
  if (node.type === schema.nodes.attachment) return makePlaceholder(node.attrs.id, node.attrs.name);
  if (node.type === schema.nodes.customEmoji) return `<:${node.attrs.name}:${node.attrs.id}>`;
  return '';
}

export function docToText(doc) {
  const lines = [];
  doc.forEach((paragraph) => {
    let line = '';
    paragraph.forEach((node) => { line += inlineToText(node); });
    lines.push(line);
  });
  return lines.join('\n');
}

// A draft attachment placeholder, or a custom emoji.
const INLINE_OBJECT_RE = /!\[((?:\\.|[^\]\\])*)\]\(attachment:(\d+)\)|<:([A-Za-z0-9_]+):(\w+)>/g;

// Message text -> editor document. `resolveCustomEmoji(id, name)` gives a custom emoji's image
// URL (by default its place in the object store); without one, `<:name:id>` stays as text.
export function textToDoc(text, { resolveCustomEmoji = (id) => customEmojiUrl(id) } = {}) {
  const paragraphs = String(text ?? '').split('\n').map((line) => {
    const content = [];
    let last = 0;
    for (const m of line.matchAll(INLINE_OBJECT_RE)) {
      let node = null;
      if (m[2]) {
        node = schema.nodes.attachment.create({ id: Number(m[2]), name: unescapeAltText(m[1]) });
      } else {
        const url = resolveCustomEmoji?.(m[4], m[3]);
        if (url) node = schema.nodes.customEmoji.create({ id: m[4], name: m[3], url });
      }
      if (!node) continue;
      if (m.index > last) content.push(schema.text(line.slice(last, m.index)));
      content.push(node);
      last = m.index + m[0].length;
    }
    if (last < line.length) content.push(schema.text(line.slice(last)));
    return schema.nodes.paragraph.create(null, content);
  });
  return schema.nodes.doc.create(null, paragraphs);
}

// Text to insert where the cursor is (lines become paragraphs, joined to the ones around).
export function textToSlice(text, options) {
  return new Slice(textToDoc(text, options).content, 1, 1);
}

// The current line up to the cursor, with chips/custom emoji as OBJECT_CHAR.
export function textBeforeCaret(state) {
  const { $from } = state.selection;
  return $from.parent.textBetween(0, $from.parentOffset, undefined, leafText);
}
