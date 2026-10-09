import { Schema, Slice } from 'prosemirror-model';
import { makePlaceholder, unescapeAltText } from '../utils/attachmentMarkup';
import { customEmojiUrl } from '../emoji/customEmoji';
import { formatTimestamp, timestampPattern, timestampText, validTimestamp } from '../utils/timestamps';

// What the message editor holds, and its conversion to and from message text (the markdown
// the rest of the app sends and stores). Lines are paragraphs. Inline, besides text:
// - attachment: a draft attachment, shown as a chip; in text `![name](attachment:ID)`.
// - sentAttachment: an attachment of a sent message being edited, shown as the same chip; in
//   text `![name](https://…)`, kept exactly as it was (the URL carries the file's key).
// - customEmoji: a custom emoji, shown as its image; in text `<:name:id>`.
// - mention: a person, shown as `@name`; in text `<@id>` (utils/mentions).
// - roleMention: a guild role, shown as `@role` in its colour; in text `<@&id>`.
// - channelMention: a guild channel, shown as `#channel`; in text `<#id>`.
// - timestamp: a time, shown as it will read (MessageEditor's node view keeps a relative one
//   counting); in text `<t:unix>` or `<t:unix:style>` (utils/timestamps), as typed.
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
    sentAttachment: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { name: {}, markup: {} },
      toDOM: (node) => [
        'span',
        { class: 'editor-attachment', contenteditable: 'false' },
        `📎 ${node.attrs.name || 'attachment'}`,
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
    mention: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { id: {}, name: {} },
      toDOM: (node) => [
        'span',
        { class: 'mention editor-mention', 'data-mention-id': String(node.attrs.id), contenteditable: 'false' },
        `@${node.attrs.name}`,
      ],
    },
    roleMention: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { id: {}, name: {}, color: { default: null } },
      toDOM: (node) => [
        'span',
        {
          class: 'mention role-mention editor-mention',
          'data-role-mention-id': String(node.attrs.id),
          contenteditable: 'false',
          ...(node.attrs.color ? { style: `--role-color: ${node.attrs.color}` } : {}),
        },
        `@${node.attrs.name}`,
      ],
    },
    channelMention: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { id: {}, name: {} },
      toDOM: (node) => [
        'span',
        { class: 'mention channel-mention editor-mention', 'data-channel-mention-id': String(node.attrs.id), contenteditable: 'false' },
        `#${node.attrs.name}`,
      ],
    },
    timestamp: {
      group: 'inline',
      inline: true,
      atom: true,
      // `style`: Discord's letter, or '' for none (which reads as 'f').
      attrs: { unix: {}, style: { default: '' } },
      toDOM: (node) => [
        'span',
        { class: 'timestamp editor-timestamp', title: formatTimestamp(node.attrs.unix, 'F'), contenteditable: 'false' },
        formatTimestamp(node.attrs.unix, node.attrs.style),
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
  if (node.type === schema.nodes.sentAttachment) return node.attrs.markup;
  if (node.type === schema.nodes.customEmoji) return `<:${node.attrs.name}:${node.attrs.id}>`;
  if (node.type === schema.nodes.mention) return `<@${node.attrs.id}>`;
  if (node.type === schema.nodes.roleMention) return `<@&${node.attrs.id}>`;
  if (node.type === schema.nodes.channelMention) return `<#${node.attrs.id}>`;
  if (node.type === schema.nodes.timestamp) return timestampText(node.attrs.unix, node.attrs.style);
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

// A draft attachment placeholder, a sent attachment (or any other markdown image), a custom
// emoji, a mention, a role mention, a channel mention, or a timestamp.
const INLINE_OBJECT_RE = /!\[((?:\\.|[^\]\\])*)\]\((?:attachment:(\d+)|(https?:\/\/[^)\s]+))\)|<:([A-Za-z0-9_]+):(\w+)>|<@(\d+)>|<@&(\d+)>|<#(\d+)>|<t:(-?\d{1,13})(?::([tTdDfFR]))?>/g;

// Message text -> editor document. `resolveCustomEmoji(id, name)` gives a custom emoji's image
// URL (by default its place in the object store); without one, `<:name:id>` stays as text.
// `resolveMention(id)` gives a mentioned person's name, `resolveRole(id)` a role's
// { name, color (#rrggbb or null) }, `resolveChannel(id)` a channel's { name }; without one,
// `<@id>` / `<@&id>` / `<#id>` stays as text.
export function textToDoc(text, { resolveCustomEmoji = (id) => customEmojiUrl(id), resolveMention, resolveRole, resolveChannel } = {}) {
  const paragraphs = String(text ?? '').split('\n').map((line) => {
    const content = [];
    let last = 0;
    for (const m of line.matchAll(INLINE_OBJECT_RE)) {
      let node = null;
      if (m[2]) {
        node = schema.nodes.attachment.create({ id: Number(m[2]), name: unescapeAltText(m[1]) });
      } else if (m[3]) {
        node = schema.nodes.sentAttachment.create({ name: unescapeAltText(m[1]), markup: m[0] });
      } else if (m[6]) {
        const name = resolveMention?.(m[6]);
        if (name != null) node = schema.nodes.mention.create({ id: m[6], name });
      } else if (m[7]) {
        const role = resolveRole?.(m[7]);
        if (role) node = schema.nodes.roleMention.create({ id: m[7], name: role.name, color: role.color ?? null });
      } else if (m[8]) {
        const channel = resolveChannel?.(m[8]);
        if (channel) node = schema.nodes.channelMention.create({ id: m[8], name: channel.name });
      } else if (m[9]) {
        if (validTimestamp(m[9])) node = schema.nodes.timestamp.create({ unix: m[9], style: m[10] ?? '' });
      } else {
        const url = resolveCustomEmoji?.(m[5], m[4]);
        if (url) node = schema.nodes.customEmoji.create({ id: m[5], name: m[4], url });
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

// Timestamps typed out in full (`<t:unix:style>` as text) in `doc`: [{ from, to, unix, style }],
// positions in the document, for MessageEditor to turn into timestamp nodes.
export function typedTimestamps(doc) {
  const found = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.text.matchAll(timestampPattern())) {
      if (validTimestamp(m[1])) found.push({ from: pos + m.index, to: pos + m.index + m[0].length, unix: m[1], style: m[2] ?? '' });
    }
  });
  return found;
}

// The current line up to the cursor, with chips/custom emoji/mentions as OBJECT_CHAR.
export function textBeforeCaret(state) {
  const { $from } = state.selection;
  return $from.parent.textBetween(0, $from.parentOffset, undefined, leafText);
}
