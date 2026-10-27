import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { remarkDiscord } from './remarkDiscord';
import { rehypeTightLists } from './rehypeTightLists';

const draw = (text) => renderToStaticMarkup(
  <ReactMarkdown remarkPlugins={[remarkGfm, remarkDiscord]} rehypePlugins={[rehypeTightLists]}>{text}</ReactMarkdown>,
);

describe('rehypeTightLists', () => {
  it('drops the newlines around a nested list', () => {
    expect(draw('- Add container:\n  - Name = `livekit`\n  - Repository\n- next')).toBe(
      '<ul><li>Add container:<ul><li>Name = <code>livekit</code></li><li>Repository</li></ul></li><li>next</li></ul>',
    );
  });

  it('keeps line breaks inside an item and outside lists', () => {
    expect(draw('- one\n  two')).toBe('<ul><li>one\ntwo</li></ul>');
    expect(draw('# a\nb')).toContain('</h1>\n<p>');
  });
});
