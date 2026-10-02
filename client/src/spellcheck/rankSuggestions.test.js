import { describe, it, expect } from 'vitest';
import { rankSuggestions } from './rankSuggestions';

describe('spelling suggestions', () => {
  it('come closest first: swapped letters, then same letters, then same length', () => {
    expect(rankSuggestions('wrold', ['wold', 'world'])).toEqual(['world', 'wold']);
    expect(rankSuggestions('teh', ['ten', 'eh', 'the', 'tea'])[0]).toBe('the');
    expect(rankSuggestions('recieve', ['relieve', 'receive'])).toEqual(['receive', 'relieve']);
    expect(rankSuggestions('definately', ['definitely'])).toEqual(['definitely']);
  });
});
