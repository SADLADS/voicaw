// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { chatPath, forgetChat, lastChat, rememberChat } from './lastChat';

describe('last chat', () => {
  beforeEach(() => localStorage.clear());

  it('knows which pages are chats', () => {
    expect(chatPath('/dm/12')).toBe('/dm/12');
    expect(chatPath('/dm/notes')).toBe('/dm/notes');
    expect(chatPath('/dm/g/0b5e-41aa')).toBe('/dm/g/0b5e-41aa');
    expect(chatPath('/dm/b/7')).toBe('/dm/b/7');
    expect(chatPath('/dm')).toBeNull();
    expect(chatPath('/dm/friends')).toBeNull();
    expect(chatPath('/settings/profile')).toBeNull();
    expect(chatPath('/invite/abc')).toBeNull();
    expect(chatPath('/')).toBeNull();
  });

  it('keeps a guild without its channel', () => {
    expect(chatPath('/guild/3/40')).toBe('/guild/3');
    expect(chatPath('/guild/3')).toBe('/guild/3');
  });

  it('remembers the last chat, not the pages after it', () => {
    expect(lastChat()).toBeNull();
    rememberChat('/guild/3/40');
    rememberChat('/dm/12');
    rememberChat('/settings/profile');
    rememberChat('/dm/friends');
    expect(lastChat()).toBe('/dm/12');
    forgetChat();
    expect(lastChat()).toBeNull();
  });

  it('ignores a stored value that is not a chat', () => {
    localStorage.setItem('lastChat', 'https://example.com/');
    expect(lastChat()).toBeNull();
  });
});
