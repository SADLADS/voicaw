import { splitEmoji, emojiImageUrl } from './emojiIndex';

// Rehype plugin (for react-markdown): replaces emoji characters in message text with
// Twemoji <img class="emoji">. Code stays as typed.
const SKIP = new Set(['code', 'pre']);

export function rehypeTwemoji(index) {
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
        for (const part of splitEmoji(child.value, index)) {
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
      node.children = children;
    };
    walk(tree);
  };
}
