import { mentionPattern } from './mentions';

// Rehype plugin (for react-markdown): turns mentions (`<@id>`) in message text into
// `<span class="mention" data-mention-id="id">`, which MessageList draws with the person's
// name (so the plugin needn't know names, and stays the same object). Code stays as typed.
const SKIP = new Set(['code', 'pre']);

export function rehypeMentions() {
  return (tree) => {
    const walk = (node) => {
      if (!node.children || (node.type === 'element' && SKIP.has(node.tagName))) return;
      const children = [];
      for (const child of node.children) {
        if (child.type !== 'text') {
          walk(child);
          children.push(child);
          continue;
        }
        let last = 0;
        for (const m of child.value.matchAll(mentionPattern())) {
          if (m.index > last) children.push({ type: 'text', value: child.value.slice(last, m.index) });
          children.push({
            type: 'element',
            tagName: 'span',
            properties: { className: ['mention'], dataMentionId: m[1] },
            children: [{ type: 'text', value: m[0] }],
          });
          last = m.index + m[0].length;
        }
        if (last === 0) children.push(child);
        else if (last < child.value.length) children.push({ type: 'text', value: child.value.slice(last) });
      }
      node.children = children;
    };
    walk(tree);
  };
}
