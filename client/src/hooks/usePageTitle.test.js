import { describe, expect, it } from 'vitest';
import { pageTitle } from './usePageTitle';

describe('pageTitle', () => {
  const guilds = [{ id: 7, name: 'Book club' }];

  it('names the area', () => {
    expect(pageTitle('/settings')).toBe('Settings');
    expect(pageTitle('/settings/privacy')).toBe('Settings');
    expect(pageTitle('/dm')).toBe('Direct Messages');
    expect(pageTitle('/dm/friends')).toBe('Friends');
    expect(pageTitle('/dm/notes')).toBe('Notes');
  });

  it('never names who a chat is with', () => {
    expect(pageTitle('/dm/12')).toBe('Direct Messages');
    expect(pageTitle('/dm/g/3')).toBe('Direct Messages');
    expect(pageTitle('/dm/b/4')).toBe('Direct Messages');
  });

  it("is the guild's name, once the guild list has it", () => {
    expect(pageTitle('/guild/7', guilds)).toBe('Book club');
    expect(pageTitle('/guild/7/99', guilds)).toBe('Book club');
    expect(pageTitle('/guild/8/99', guilds)).toBe(null);
    expect(pageTitle('/invite/abc', guilds)).toBe(null);
  });
});
