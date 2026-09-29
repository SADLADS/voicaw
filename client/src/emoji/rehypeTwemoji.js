import { splitEmoji, emojiImageUrl } from './emojiIndex';
import { customEmojiPattern, customEmojiUrl } from './customEmoji';

// Rehype plugin (for react-markdown): replaces emoji characters in message text with
// Twemoji <img class="emoji">, and custom emoji (`<:name:id>`) with their image
// (`data-custom-emoji` = the name, so a deleted one can fall back to `:name:`). Code stays as
// typed. `s3Endpoint` is where custom emoji images are.
const SKIP = new Set(['code', 'pre']);

// Splits text into strings and custom emoji: [{ text }, { custom: { name, id } }].
function splitCustom(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(customEmojiPattern())) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ custom: { name: m[1], id: m[2] } });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

const customImage = ({ name, id }, s3Endpoint) => ({
  type: 'element',
  tagName: 'img',
  properties: {
    className: ['emoji', 'custom-emoji'],
    src: customEmojiUrl(id, s3Endpoint) ?? '',
    alt: `:${name}:`,
    title: `:${name}:`,
    draggable: 'false',
    dataCustomEmoji: name,
  },
  children: [],
});

export function rehypeTwemoji(index, s3Endpoint) {
  return () => (tree) => {
    const walk = (node) => {
      if (!node.children || (node.type === 'element' && SKIP.has(node.tagName))) return;
      const children = [];
      for (const child of node.children) {
        if (child.type !== 'text') {
          walk(child);
          children.push(child);
          continue;
        }
        for (const piece of splitCustom(child.value)) {
          if (piece.custom) {
            children.push(customImage(piece.custom, s3Endpoint));
            continue;
          }
          for (const part of index ? splitEmoji(piece.text, index) : [{ text: piece.text }]) {
          children.push(part.emoji
            ? {
              type: 'element',
              tagName: 'img',
              properties: {
                className: ['emoji'],
                src: emojiImageUrl(part.skin.unified),
                alt: part.native,
                title: `:${part.emoji.id}:`,
                draggable: 'false',
              },
              children: [],
            }
            : { type: 'text', value: part.text });
          }
        }
      }
      node.children = children;
    };
    walk(tree);
  };
}
