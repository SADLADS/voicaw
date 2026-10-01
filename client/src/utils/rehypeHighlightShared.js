import rehypeHighlight from 'rehype-highlight';

// rehype-highlight, set up once. react-markdown builds its processor on every render, which runs
// each plugin's setup again, and rehype-highlight's registers some 40 highlight.js languages:
// a few ms each time, for every message, embed field and description drawn. Its transformer
// keeps nothing between documents, so one can serve every message.
let transformer = null;

export function rehypeHighlightShared() {
  transformer ??= rehypeHighlight();
  return transformer;
}
