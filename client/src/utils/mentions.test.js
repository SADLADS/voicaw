import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mentionsMe, mentionsToText, mentionsUser, searchMentions, searchPeople } from './mentions';
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

  it('shows role mentions by name too', () => {
    expect(mentionsToText('<@&5> and <@&6>, <@2>', { 2: 'Anna' }, { 5: { name: 'Mods' } })).toBe('@Mods and @deleted-role, @Anna');
  });

  it('tells whether a message is for you: by name, @everyone/@here that pinged, or your roles', () => {
    expect(mentionsMe({ plaintext: 'hi <@1>' }, 1, [])).toBe(true);
    expect(mentionsMe({ plaintext: '@everyone', mention_everyone: 0 }, 1, [])).toBe(false);
    expect(mentionsMe({ plaintext: '@here', mention_everyone: 1 }, 1, [])).toBe(true);
    expect(mentionsMe({ plaintext: '<@&7>', mention_roles: [7] }, 1, [7])).toBe(true);
    expect(mentionsMe({ plaintext: '<@&7>', mention_roles: [] }, 1, [7])).toBe(false);
  });

  it('suggests people, then roles, then @everyone and @here', () => {
    const roles = [{ id: 9, name: 'Anniversary', color: '#ff0000' }];
    expect(searchMentions({ people, roles, everyone: true }, 'an').map((i) => `${i.kind}:${i.name}`))
      .toEqual(['user:Anna', 'user:hannah', 'role:Anniversary']);
    expect(searchMentions({ people, roles, everyone: true }, 'e').map((i) => `${i.kind}:${i.name}`))
      .toEqual(['role:Anniversary', 'everyone:everyone', 'everyone:here']);
    expect(searchMentions({ people }, 'every')).toEqual([]);
    // Many people still leave room for roles and @everyone.
    const crowd = Array.from({ length: 20 }, (_, i) => ({ id: i + 10, username: `eve${i}` }));
    const found = searchMentions({ people: crowd, roles: [{ id: 1, name: 'events' }], everyone: true }, 'eve');
    expect(found).toHaveLength(10);
    expect(found.slice(-2).map((i) => i.name)).toEqual(['events', 'everyone']);
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

  it('marks role mentions and @everyone/@here (not in words or addresses)', () => {
    expect(render('<@&4> (@everyone) hi@here')).toBe(
      '<p><span class="mention" data-role-mention-id="4">&lt;@&amp;4&gt;</span> '
      + '(<span class="mention" data-mention-everyone="everyone">@everyone</span>) hi@here</p>'
    );
    expect(render('@here')).toBe('<p><span class="mention" data-mention-everyone="here">@here</span></p>');
  });

  it('leaves code and look-alikes alone', () => {
    expect(render('`<@2>`')).toBe('<p><code>&lt;@2&gt;</code></p>');
    expect(render('mail a@b.test <@x>')).not.toContain('mention');
  });
});
