import { describe, it, expect, beforeAll } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import data from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from './emojiIndex';
import { rehypeTwemoji } from './rehypeTwemoji';

let index;
beforeAll(() => { index = buildEmojiIndex(data); });

const render = (md) => renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: [rehypeTwemoji(index)] }, md));

describe('rehypeTwemoji', () => {
  it('renders emoji as self-hosted Twemoji images, keeping the text around them', () => {
    const html = render('nice 👍🏽 **bold 😄**');
    expect(html).toContain('<img class="emoji" src="/emoji/1f44d-1f3fd.svg" alt="👍🏽" title=":+1:" draggable="false"/>');
    expect(html).toContain('<strong>bold <img class="emoji" src="/emoji/1f604.svg" alt="😄"');
    expect(html).toContain('nice ');
  });

  it('leaves emoji inside code alone', () => {
    expect(render('`😄`')).toBe('<p><code>😄</code></p>');
  });

  it('renders custom emoji as their images, marked with their name', () => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: [rehypeTwemoji(index, 'https://s3.test')] }, 'hi <:party_blob:42> 😄'));
    expect(html).toContain('<img class="emoji custom-emoji" src="https://s3.test/emojis/42" alt=":party_blob:" title=":party_blob:" draggable="false" data-custom-emoji="party_blob"/>');
    expect(html).toContain('<img class="emoji" src="/emoji/1f604.svg"');
    // Not inside code.
    expect(renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: [rehypeTwemoji(index, 'https://s3.test')] }, '`<:party_blob:42>`')))
      .toBe('<p><code>&lt;:party_blob:42&gt;</code></p>');
  });

  it('leaves text without emoji untouched', () => {
    expect(render('just text')).toBe('<p>just text</p>');
  });
});
