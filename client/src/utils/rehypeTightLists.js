// Rehype plugin (for react-markdown): drops the newlines markdown leaves between a list's
// blocks. Message text keeps its line breaks (white-space: pre-wrap on li), so the "\n" between
// <li>s and around a nested list in its <li> drew as blank lines around every nested bullet.
const BLOCKS = new Set(['ul', 'ol', 'li', 'p', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'hr', 'div']);
const LISTS = new Set(['ul', 'ol', 'li']);

const isBlock = (node) => node?.type === 'element' && BLOCKS.has(node.tagName);
const isBlank = (node) => node.type === 'text' && !/\S/.test(node.value);

export function rehypeTightLists() {
  return (tree) => {
    const walk = (node) => {
      if (!node.children) return;
      if (node.type === 'element' && LISTS.has(node.tagName)) {
        node.children = node.children.filter((child, i, all) =>
          !isBlank(child) || !(isBlock(all[i - 1]) || isBlock(all[i + 1])));
      }
      node.children.forEach(walk);
    };
    walk(tree);
  };
}
