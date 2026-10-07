import { describe, it, expect } from 'vitest';
import { isPanesPage, replacesEntry } from './phoneHistory';

describe('phoneHistory', () => {
  it('knows the chat pages', () => {
    for (const path of ['/dm', '/dm/1', '/dm/g/2', '/dm/b/3', '/dm/notes', '/dm/friends', '/guild/4', '/guild/4/5']) {
      expect(isPanesPage(path)).toBe(true);
    }
    for (const path of ['/', '/settings', '/settings/profile', '/invite/abc', '/developers', '/dmx', '/guilds']) {
      expect(isPanesPage(path)).toBe(false);
    }
  });

  it('replaces the entry only from one chat page to another', () => {
    expect(replacesEntry('/dm/1', '/guild/4/5')).toBe(true);
    expect(replacesEntry('/guild/4/5', '/guild/6')).toBe(true);
    expect(replacesEntry('/guild/4/5', '/guild/4/5')).toBe(false); // a thread, the voice chat
    expect(replacesEntry('/dm/1', '/settings')).toBe(false);
    expect(replacesEntry('/settings', '/dm/1')).toBe(false);
  });
});
