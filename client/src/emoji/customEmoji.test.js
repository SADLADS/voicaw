import { describe, it, expect } from 'vitest';
import {
  customEmojiByName,
  customEmojiText,
  customEmojiToText,
  customEmojiUrl,
  parseCustomEmoji,
  searchCustomEmoji,
  setCustomEmojiBase,
} from './customEmoji';
import { emojiNameFromFile } from '../utils/guildDisplay';

const one = { guild: { id: 1, name: 'One' }, emojis: [{ id: 10, name: 'blob' }, { id: 11, name: 'party_blob' }] };
const two = { guild: { id: 2, name: 'Two' }, emojis: [{ id: 20, name: 'blob' }, { id: 21, name: 'blobcat' }] };
const custom = { guilds: [one, two] };

describe('custom emoji helpers', () => {
  it('reads and writes the <:name:id> form', () => {
    expect(customEmojiText({ id: 42, name: 'blob' })).toBe('<:blob:42>');
    expect(parseCustomEmoji('<:blob:42>')).toEqual({ name: 'blob', id: '42' });
    expect(parseCustomEmoji('👍')).toBeNull();
    expect(parseCustomEmoji('<:blob:42> ')).toBeNull();
    expect(parseCustomEmoji('<:b:42>')).toBeNull();
    expect(customEmojiToText('hi <:blob:42> and <:cat_2:7>')).toBe('hi :blob: and :cat_2:');
  });

  it('finds the image by id', () => {
    expect(customEmojiUrl(42, 'https://s3.test')).toBe('https://s3.test/emojis/42');
    setCustomEmojiBase('https://media.test');
    expect(customEmojiUrl(42)).toBe('https://media.test/emojis/42');
  });

  it('searches by name, best match first', () => {
    expect(searchCustomEmoji(custom, 'blob').map((e) => e.id)).toEqual([10, 20, 21, 11]);
    expect(searchCustomEmoji(custom, ':party').map((e) => e.id)).toEqual([11]);
    expect(searchCustomEmoji(custom, '')).toEqual([]);
  });

  it('finds an emoji by name, in rail order when several guilds have one', () => {
    expect(customEmojiByName(custom, 'blob').id).toBe(10);
    expect(customEmojiByName(custom, 'blobcat').id).toBe(21);
    expect(customEmojiByName(custom, 'nope')).toBeNull();
  });

  it('names an uploaded file', () => {
    expect(emojiNameFromFile('party blob (1).gif')).toBe('party_blob_1');
    expect(emojiNameFromFile('x.png')).toBe('emoji_x');
    expect(emojiNameFromFile(`${'a'.repeat(40)}.png`)).toHaveLength(32);
  });
});
