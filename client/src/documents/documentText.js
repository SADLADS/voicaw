import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkDocument } from '../utils/remarkDiscord';

// Documents' markdown (see remarkDocument) as a syntax tree (mdast), parsed exactly as the
// document page renders it. Shared by the editor (documentMarkdown.js) and the feed's excerpts.

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkDocument);

export function parseDocumentTree(markdown) {
  const file = { value: markdown };
  return processor.runSync(processor.parse(markdown), file);
}

const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'listItem', 'code', 'tableRow', 'table']);

// A document's start as one line of plain text for its feed card: no markup, images or
// links' addresses; blocks become spaces. At most `max` characters (an ellipsis when cut).
export function documentExcerpt(markdown, max = 220) {
  if (!markdown) return '';
  const parts = [];
  const walk = (node) => {
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') parts.push(node.value);
    else if (node.type === 'break') parts.push(' ');
    else if (node.type !== 'image' && node.type !== 'html') node.children?.forEach(walk);
    if (BLOCKS.has(node.type) || node.type === 'tableCell') parts.push(' ');
  };
  walk(parseDocumentTree(markdown));
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
