// Rehype plugin (for react-markdown): marks mentions in message text so MessageList can draw
// them with current names (the plugin needn't know names, and stays the same object):
// `<@id>` → <span class="mention" data-mention-id>, `<@&id>` → <span data-role-mention-id>,
// `<#id>` → <span data-channel-mention-id>,
// `@everyone` / `@here` → <span data-mention-everyone> (drawn as a mention only if the message
// really pinged them). Code stays as typed.
const SKIP = new Set(['code', 'pre']);

// A person, a role, @everyone/@here (not inside a word or an address), or a channel.
const MENTION_RE = /<@(\d+)>|<@&(\d+)>|(^|[^\w@])@(everyone|here)\b|<#(\d+)>/g;

function mentionNode(m) {
  if (m[1]) return { dataMentionId: m[1] };
  if (m[2]) return { dataRoleMentionId: m[2] };
  if (m[5]) return { dataChannelMentionId: m[5] };
  return { dataMentionEveryone: m[4] };
}

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
        for (const m of child.value.matchAll(MENTION_RE)) {
          // @everyone's match starts with the character before it, which stays text.
          const start = m.index + (m[3]?.length ?? 0);
          if (start > last) children.push({ type: 'text', value: child.value.slice(last, start) });
          const text = m[0].slice(m[3]?.length ?? 0);
          children.push({
            type: 'element',
            tagName: 'span',
            properties: { className: ['mention'], ...mentionNode(m) },
            children: [{ type: 'text', value: text }],
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
