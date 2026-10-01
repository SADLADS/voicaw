import { describe, it, expect } from 'vitest';
import { acceleratorFromEvent, describeAccelerator, unreadSummary } from './desktop';

const key = (code, key, mods = {}) => ({ code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('unreadSummary', () => {
  it('counts DMs, group messages and mentions; a dot for any unread channel', () => {
    expect(unreadSummary({
      unreadDms: [{ from_user_id: 2, count: 3 }, { from_user_id: 4, count: 1 }],
      groups: [{ id: 'g', unread: 2 }, { id: 'h', unread: 0 }],
      guildUnread: [{ channel_id: 9, mentions: 1 }, { channel_id: 8, mentions: 0 }],
    })).toEqual({ count: 7, dot: true });
    expect(unreadSummary({ guildUnread: [{ channel_id: 8, mentions: 0 }] })).toEqual({ count: 0, dot: true });
    expect(unreadSummary({})).toEqual({ count: 0, dot: false });
  });
});

describe('acceleratorFromEvent', () => {
  it('names a key with its modifiers', () => {
    expect(acceleratorFromEvent(key('KeyM', 'm', { ctrlKey: true, shiftKey: true }), 'linux')).toBe('Control+Shift+M');
    expect(acceleratorFromEvent(key('Digit1', '!', { altKey: true, shiftKey: true }), 'win32')).toBe('Alt+Shift+1');
    expect(acceleratorFromEvent(key('KeyD', 'd', { metaKey: true }), 'darwin')).toBe('Command+D');
    expect(acceleratorFromEvent(key('Space', ' ', { ctrlKey: true }), 'linux')).toBe('Control+Space');
    expect(acceleratorFromEvent(key('Numpad5', '5', { ctrlKey: true }), 'linux')).toBe('Control+num5');
  });

  it('allows a function key alone, but no other plain key', () => {
    expect(acceleratorFromEvent(key('F9', 'F9'), 'linux')).toBe('F9');
    expect(acceleratorFromEvent(key('KeyM', 'm'), 'linux')).toBeNull();
    expect(acceleratorFromEvent(key('ShiftLeft', 'Shift', { shiftKey: true }), 'linux')).toBeNull();
    expect(acceleratorFromEvent(key('IntlBackslash', '\\', { ctrlKey: true }), 'linux')).toBeNull();
  });
});

describe('describeAccelerator', () => {
  it('reads like the platform writes shortcuts', () => {
    expect(describeAccelerator('Control+Shift+M', 'linux')).toBe('Ctrl + Shift + M');
    expect(describeAccelerator('Command+Shift+M', 'darwin')).toBe('⌘ ⇧ M');
    expect(describeAccelerator(null, 'linux')).toBe('');
  });
});
