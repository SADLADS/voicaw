import { frequentEmojiIds, getSkinTone, skinFor } from './emojiUsage';

// Offered first, after the person's own most used emoji.
const DEFAULT_QUICK_REACTIONS = ['+1', 'heart', 'joy', 'open_mouth', 'cry', 'pray'];

// The reactions a message's actions offer in one tap (the mobile sheet, the right-click menu):
// the person's most used emoji, then the defaults, each in their skin tone.
// [{ emoji, skin }] from the emoji `index`.
export function quickReactions(index, count = 6) {
  const tone = getSkinTone();
  const ids = [...new Set([...frequentEmojiIds(count), ...DEFAULT_QUICK_REACTIONS])];
  return ids
    .map((id) => index.emojis.get(id))
    .filter(Boolean)
    .slice(0, count)
    .map((emoji) => ({ emoji, skin: skinFor(emoji, tone) }));
}
