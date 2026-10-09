import { describe, expect, it } from 'vitest';
import { parseSearch, searchContext, searchSuggestions } from './searchQuery';

const members = [
  { id: 1, username: 'alice', display_name: 'Alice Smith' },
  { id: 2, username: 'bob', display_name: null },
  { id: 3, username: 'bobby', display_name: 'Rob' },
];
const channels = [{ id: 10, name: 'general' }, { id: 11, name: 'random' }];
const opts = { members, channels };

describe('parseSearch', () => {
  it('turns filters into ids and leaves the words', () => {
    const { params, problems, empty } = parseSearch('pizza from:alice in:#random has:Image mentions:@bob tonight', opts);
    expect(problems).toEqual([]);
    expect(empty).toBe(false);
    expect(params).toEqual({ content: 'pizza tonight', author_id: [1], mentions: [2], channel_id: [11], has: ['image'] });
  });

  it('finds people by display name when only one has it, quoted with spaces', () => {
    expect(parseSearch('from:"Alice Smith"', opts).params.author_id).toEqual([1]);
    expect(parseSearch('from:rob', opts).params.author_id).toEqual([3]);
    expect(parseSearch('FROM:Bob from:bob', opts).params.author_id).toEqual([2]);
  });

  it('reports what it doesn\'t know', () => {
    const { problems } = parseSearch('from:nobody in:nowhere has:sticker', opts);
    expect(problems).toEqual(['No member called nobody', 'No channel called #nowhere', expect.stringMatching(/^has: can be link/)]);
  });

  it('keeps quoted phrases and ignores empty filters', () => {
    expect(parseSearch('"exact words" from:', opts)).toMatchObject({ params: { content: '"exact words"' }, problems: [] });
    expect(parseSearch('from:', opts).empty).toBe(true);
    expect(parseSearch('   ', opts).empty).toBe(true);
    expect(parseSearch('has:link', opts).empty).toBe(false);
  });

  it("doesn't take a word that only contains a filter", () => {
    expect(parseSearch('xfrom:alice', opts).params).toMatchObject({ content: 'xfrom:alice', author_id: [] });
  });
});

describe('suggestions', () => {
  it('offers the filters in an empty box or for a word that starts one', () => {
    expect(searchSuggestions(searchContext(''), opts).map((s) => s.insert)).toEqual(['from:', 'mentions:', 'in:', 'has:']);
    expect(searchSuggestions(searchContext('pizza m'), opts).map((s) => s.insert)).toEqual(['mentions:']);
    expect(searchSuggestions(searchContext('pizza '), opts)).toEqual([]);
    expect(searchSuggestions(searchContext('pizza'), opts)).toEqual([]);
  });

  it('offers values for the filter at the caret', () => {
    expect(searchSuggestions(searchContext('from:bo'), opts).map((s) => s.insert)).toEqual(['from:bob ', 'from:bobby ']);
    expect(searchSuggestions(searchContext('mentions:ro'), { ...opts, nameOf: (m) => m.display_name || m.username }).map((s) => s.id)).toEqual([3]);
    expect(searchSuggestions(searchContext('in:ran'), opts).map((s) => s.insert)).toEqual(['in:random ']);
    expect(searchSuggestions(searchContext('has:'), opts)).toHaveLength(7);
    expect(searchSuggestions(searchContext('has:vi'), opts).map((s) => s.insert)).toEqual(['has:video ']);
    // The word the caret is in, not the last one.
    const text = 'from:al pizza';
    const context = searchContext(text, 7);
    expect(context).toMatchObject({ kind: 'from', value: 'al', start: 0 });
  });
});

describe('fewer filters (DMs and groups)', () => {
  const keys = ['from', 'mentions', 'has'];
  const hasValues = ['link', 'file', 'image', 'video', 'sound', 'poll'];
  const dmOpts = { ...opts, keys, hasValues };

  it('leaves out in: and has:embed', () => {
    expect(searchSuggestions(searchContext('', 0, keys), dmOpts).map((s) => s.insert)).toEqual(['from:', 'mentions:', 'has:']);
    expect(searchSuggestions(searchContext('i', 1, keys), dmOpts)).toEqual([]);
    expect(searchSuggestions(searchContext('has:e', 5, keys), dmOpts)).toEqual([]);
    // in: is only words there.
    expect(parseSearch('in:general pizza', dmOpts).params).toMatchObject({ content: 'in:general pizza', channel_id: [] });
    expect(parseSearch('has:embed', dmOpts).problems).toHaveLength(1);
    expect(parseSearch('from:alice has:poll', dmOpts).params).toMatchObject({ author_id: [1], has: ['poll'] });
  });
});
