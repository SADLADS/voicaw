import { isVote } from './pollMarkup';

// Groups decrypted reactions ([{ id, user_id, emoji }]) by emoji, in the order each emoji was
// first used, counting each person once (two devices can race to add the same one). Poll
// votes (utils/pollMarkup.js) are reactions too, but aren't shown as chips.
export function groupReactions(reactions) {
  const groups = new Map();
  for (const reaction of reactions ?? []) {
    if (isVote(reaction.emoji)) continue;
    let group = groups.get(reaction.emoji);
    if (!group) {
      group = { emoji: reaction.emoji, userIds: [] };
      groups.set(reaction.emoji, group);
    }
    if (!group.userIds.includes(reaction.user_id)) group.userIds.push(reaction.user_id);
  }
  return [...groups.values()];
}
