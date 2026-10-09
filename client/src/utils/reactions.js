import { isPollReaction } from './pollMarkup';
import { parseCustomEmoji } from '../emoji/customEmoji';

// Groups decrypted reactions ([{ id, user_id, emoji }]) by emoji, in the order each emoji was
// first used, counting each person once (two devices can race to add the same one). Poll
// votes and added answers (utils/pollMarkup.js) are reactions too, but aren't shown as chips.
export function groupReactions(reactions) {
  const groups = new Map();
  for (const reaction of reactions ?? []) {
    if (isPollReaction(reaction.emoji)) continue;
    let group = groups.get(reaction.emoji);
    if (!group) {
      group = { emoji: reaction.emoji, userIds: [] };
      groups.set(reaction.emoji, group);
    }
    if (!group.userIds.includes(reaction.user_id)) group.userIds.push(reaction.user_id);
  }
  return [...groups.values()];
}

// A reaction's name for "…reacted by": a custom emoji's name, or a Unicode emoji's shortcode
// (`thumbsup`, from the emoji index, null until it's loaded or for one it doesn't know).
export function reactionShortName(emoji, index) {
  const custom = parseCustomEmoji(emoji);
  if (custom) return custom.name;
  return index?.byNative.get(emoji)?.emoji.id ?? null;
}
