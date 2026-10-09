import { describe, it, expect, vi, beforeEach } from 'vitest';
import data from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from './emojiIndex';
import { setCustomEmojiBase } from './customEmoji';
import { recordEmojiUse, resetEmojiUsage, setSkinTone } from './emojiUsage';
import { quickReactions, recordReactionUse } from './quickReactions';

vi.mock('../utils/api', () => ({ default: { get: vi.fn(), put: vi.fn() } }));
vi.mock('../utils/ws-client', () => ({ onConnectionState: vi.fn(() => () => {}), onEmojiUsage: vi.fn(() => () => {}) }));
vi.mock('../services/keyStore', () => ({ loadEncryptionKey: vi.fn(), loadOwnPublicKeys: vi.fn() }));

const index = buildEmojiIndex(data);
const partyParrot = { id: '42', name: 'party_parrot', guild: { id: 1 } };
const custom = { guilds: [], byId: new Map([['42', partyParrot]]) };
const texts = (list) => list.map((r) => r.text);
const use = (id, times) => { for (let i = 0; i < times; i += 1) recordEmojiUse(id); };

beforeEach(() => {
  resetEmojiUsage();
  setCustomEmojiBase('https://files.example');
});

describe('quickReactions', () => {
  it('offers the defaults before anything has been used', () => {
    expect(texts(quickReactions(index))).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏']);
  });

  it('puts the most used first, topping up with the defaults', () => {
    use('fire', 3);
    use('eyes', 5);
    expect(texts(quickReactions(index, 5))).toEqual(['👀', '🔥', '👍', '❤️', '😂']);
  });

  it('shows only your own once you have used enough', () => {
    ['fire', 'eyes', 'skull', 'sob', 'tada', 'rocket'].forEach((id, i) => use(id, 10 - i));
    expect(texts(quickReactions(index, 5))).toEqual(['🔥', '👀', '💀', '😭', '🎉']);
  });

  it('offers custom emoji you can use, skipping those you no longer can', () => {
    use('custom:42', 4);
    use('custom:99', 3); // a guild you've left
    use('fire', 2);
    const offered = quickReactions(index, 3, custom);
    expect(texts(offered)).toEqual(['<:party_parrot:42>', '🔥', '👍']);
    expect(offered[0]).toMatchObject({ name: 'party_parrot', src: 'https://files.example/emojis/42' });
  });

  it('uses your skin tone', () => {
    use('wave', 1);
    setSkinTone(2);
    expect(quickReactions(index, 1)[0].text).toBe('👋🏼');
  });
});

describe('recordReactionUse', () => {
  it('counts standard emoji (any skin tone) and custom emoji', () => {
    recordReactionUse('👋🏽', index);
    recordReactionUse('<:party_parrot:42>', index);
    recordReactionUse('<:party_parrot:42>', index);
    recordReactionUse('not an emoji', index);
    expect(texts(quickReactions(index, 2, custom))).toEqual(['<:party_parrot:42>', '👋']);
  });
});
