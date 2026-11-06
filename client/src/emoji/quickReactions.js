import { frequentReactionIds, getSkinTone, recordEmojiReaction, recordEmojiUse, skinFor } from './emojiUsage';
import { emojiImageUrl } from './emojiIndex';
import { customEmojiText, customEmojiUrl, customUsageId, parseCustomEmoji } from './customEmoji';

// Only when fewer than `count` emoji have been reacted with yet, after them.
const DEFAULT_QUICK_REACTIONS = ['+1', 'heart', 'joy', 'open_mouth', 'cry', 'pray'];

// Usage ids looked at, so emoji that can't be offered (a guild you've left) don't let the
// defaults back in.
const LOOK_AT = 32;

// The reactions a message's actions offer in one tap (the mobile sheet, the right-click menu),
// the emoji the person reacts with most (custom ones from `custom`, the CustomEmojiContext,
// too; what they put in messages doesn't count), each in their skin tone, topped up with the
// defaults.
// [{ id, text (the reaction to send), name, title, alt, src }] from the emoji `index`.
export function quickReactions(index, count = 6, custom = null) {
  const tone = getSkinTone();
  const ids = [...new Set([...frequentReactionIds(LOOK_AT), ...DEFAULT_QUICK_REACTIONS])];
  const offered = [];
  for (const id of ids) {
    if (offered.length === count) break;
    if (id.startsWith('custom:')) {
      const emoji = custom?.byId.get(id.slice(7));
      const src = emoji && customEmojiUrl(emoji.id);
      if (src) offered.push({ id, text: customEmojiText(emoji), name: emoji.name, title: `:${emoji.name}:`, alt: `:${emoji.name}:`, src });
      continue;
    }
    const emoji = index.emojis.get(id);
    if (!emoji) continue;
    const skin = skinFor(emoji, tone);
    offered.push({ id, text: skin.native, name: emoji.name, title: `:${emoji.id}:`, alt: skin.native, src: emojiImageUrl(skin.unified) });
  }
  return offered;
}

// Counts the reaction `text` you just added (a standard emoji or `<:name:id>`), so the emoji
// you react with most come first. It's also a use for the picker's Frequently Used, unless it
// came `fromPicker`, which counted that itself.
export function recordReactionUse(text, index, { fromPicker = false } = {}) {
  const customEmoji = parseCustomEmoji(text);
  const id = customEmoji ? customUsageId(customEmoji.id) : index?.byNative.get(text)?.emoji.id;
  if (!id) return;
  recordEmojiReaction(id);
  if (!fromPicker) recordEmojiUse(id);
}
