import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mentionsToText, mentionsUser, searchPeople } from './mentions';
import { rehypeMentions } from './rehypeMentions';

const people = [
  { id: 1, username: 'otto' },
  { id: 2, username: 'Anna' },
  { id: 3, username: 'hannah' },
  { id: 4, username: 'bob' },
];

describe('mentions', () => {
  it('shows mentions as @name in plain text, unknown people too', () => {
    expect(mentionsToText('hi <@2> and <@99>!', { 2: 'Anna' })).toBe('hi @Anna and @unknown-user!');
    expect(mentionsToText(null, {})).toBe(null);
  });

  it('tells whether a message mentions someone', () => {
    expect(mentionsUser('hey <@12>', 12)).toBe(true);
    expect(mentionsUser('hey <@123>', 12)).toBe(false);
    expect(mentionsUser('hey @12', 12)).toBe(false);
  });

  it('finds people by the start of their name first, then anywhere in it', () => {
    expect(searchPeople(people, 'an').map((p) => p.username)).toEqual(['Anna', 'hannah']);
    expect(searchPeople(people, '').map((p) => p.username)).toEqual(['Anna', 'bob', 'hannah', 'otto']);
    expect(searchPeople(people, '', 2)).toHaveLength(2);
    expect(searchPeople(people, 'zz')).toEqual([]);
  });
});

describe('rehypeMentions', () => {
  const render = (md) => renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeMentions] }, md)
  );

  it('marks mentions in message text, keeping the text around them', () => {
    expect(render('hi <@2>, **<@3>**!')).toBe(
      '<p>hi <span class="mention" data-mention-id="2">&lt;@2&gt;</span>, '
      + '<strong><span class="mention" data-mention-id="3">&lt;@3&gt;</span></strong>!</p>'
    );
  });

  it('leaves code and look-alikes alone', () => {
    expect(render('`<@2>`')).toBe('<p><code>&lt;@2&gt;</code></p>');
    expect(render('mail a@b.test <@x>')).not.toContain('mention');
  });
});
