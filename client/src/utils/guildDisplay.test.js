import { describe, it, expect, beforeEach } from 'vitest';
import { channelLink, defaultChannel, groupChannels, guildInitials, parseChannelLink, parseInviteCode, rememberChannel } from './guildDisplay';

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
};

const guild = {
  id: 7,
  categories: [{ id: 2, name: 'Second', position: 1 }, { id: 1, name: 'First', position: 0 }],
  channels: [
    { id: 10, name: 'voice', type: 'voice', category_id: null, position: 0 },
    { id: 11, name: 'b', type: 'text', category_id: 1, position: 3 },
    { id: 12, name: 'a', type: 'text', category_id: 1, position: 1 },
    { id: 13, name: 'c', type: 'text', category_id: 2, position: 2 },
    { id: 14, name: 'orphan', type: 'text', category_id: 99, position: 4 },
  ],
};

describe('guildDisplay', () => {
  beforeEach(() => storage.clear());

  it('makes initials from the first letter of each word', () => {
    expect(guildInitials('Test Guild')).toBe('TG');
    expect(guildInitials('voicaw')).toBe('v');
    expect(guildInitials('  one two three four ')).toBe('ott');
    expect(guildInitials('🎮 Gamers')).toBe('🎮G');
  });

  it('groups channels: uncategorised first, then categories, all in order', () => {
    const { uncategorized, categories } = groupChannels(guild);
    expect(uncategorized.map((c) => c.id)).toEqual([10, 14]);
    expect(categories.map((c) => [c.name, c.channels.map((ch) => ch.id)])).toEqual([
      ['First', [12, 11]],
      ['Second', [13]],
    ]);
  });

  it('opens the remembered channel, else the first text channel', () => {
    expect(defaultChannel(guild).id).toBe(14);
    rememberChannel(7, 13);
    expect(defaultChannel(guild).id).toBe(13);
    rememberChannel(7, 999); // deleted since
    expect(defaultChannel(guild).id).toBe(14);
    expect(defaultChannel({ id: 8, categories: [], channels: [] })).toBeNull();
  });

  it('finds the code in an invite link or a bare code', () => {
    expect(parseInviteCode('https://voicaw.com/invite/hTKzmak1')).toBe('hTKzmak1');
    expect(parseInviteCode(' hTKzmak1 ')).toBe('hTKzmak1');
    expect(parseInviteCode('http://localhost:5199/invite/abc/')).toBe('abc');
    expect(parseInviteCode('not a code!')).toBeNull();
    expect(parseInviteCode('https://app.voicaw.com/invite/cool-guild')).toBe('cool-guild');
    expect(parseInviteCode('')).toBeNull();
  });

  it("finds the guild and channel in a link to this site's or app.voicaw.com's channel", () => {
    globalThis.window = { location: { protocol: 'http:', origin: 'http://localhost:5199' } };
    try {
      expect(parseChannelLink(channelLink(7, 12))).toEqual({ guildId: '7', channelId: '12' });
      expect(parseChannelLink('https://app.voicaw.com/guild/7/12/')).toEqual({ guildId: '7', channelId: '12' });
      expect(parseChannelLink('https://example.com/guild/7/12')).toBeNull();
      expect(parseChannelLink('http://localhost:5199/guild/7')).toBeNull();
      expect(parseChannelLink('http://localhost:5199/guild/7/12?x=1')).toBeNull();
      expect(parseChannelLink(undefined)).toBeNull();
    } finally {
      delete globalThis.window;
    }
  });
});
