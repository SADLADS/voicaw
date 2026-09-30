import React, { useContext, useState } from 'react';
import { ConfigContext } from '../contexts';
import { customEmojiUrl, parseCustomEmoji } from '../emoji/customEmoji';
import { useEmojiIndex } from '../emoji/emojiContext';
import { emojiImageUrl } from '../emoji/emojiIndex';
import { groupReactions } from '../utils/reactions';

// A reaction's emoji: Unicode (as Twemoji), or a custom emoji's image (`:name:` if deleted).
// Poll answers' emoji too.
export function ReactionEmoji({ native }) {
  const index = useEmojiIndex();
  const { s3Endpoint } = useContext(ConfigContext);
  const [failed, setFailed] = useState(false);
  const custom = parseCustomEmoji(native);
  if (custom) {
    const src = customEmojiUrl(custom.id, s3Endpoint);
    if (failed || !src) return <span className="reaction-native">:{custom.name}:</span>;
    return <img className="emoji" src={src} alt={`:${custom.name}:`} title={`:${custom.name}:`} draggable={false} onError={() => setFailed(true)} />;
  }
  const match = index?.byNative.get(native);
  if (!match) return <span className="reaction-native">{native}</span>;
  return <img className="emoji" src={emojiImageUrl(match.skin.unified)} alt={native} draggable={false} />;
}

// Discord-style reaction chips under a message: tap one to add or remove your own, `+` to
// pick another. `names` maps user id -> username, for the tooltip.
// Without `onAdd` (not allowed to react), there's no "+" and only your own chips can be tapped
// (to take your reaction back).
export default function MessageReactions({ reactions, userId, names, onToggle, onAdd }) {
  const groups = groupReactions(reactions);
  if (groups.length === 0) return null;

  return (
    <div className="message-reactions">
      {groups.map(({ emoji, userIds }) => {
        const mine = userIds.includes(userId);
        const who = userIds.map((id) => (id === userId ? 'You' : names?.[id] ?? 'Someone')).join(', ');
        return (
          <button
            key={emoji}
            type="button"
            className={`reaction-chip${mine ? ' mine' : ''}`}
            aria-pressed={mine}
            aria-label={`${emoji} ${userIds.length}, reacted by ${who}`}
            title={`Reacted by ${who}`}
            disabled={!mine && !onAdd}
            onClick={() => onToggle(emoji)}
          >
            <ReactionEmoji native={emoji} />
            <span className="reaction-count">{userIds.length}</span>
          </button>
        );
      })}
      {onAdd && <button
        type="button"
        className="reaction-chip reaction-add"
        aria-label="Add reaction"
        title="Add reaction"
        // Keep the open picker's outside-click handler from closing it before this toggles it.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => onAdd(e.currentTarget)}
      >
        +
      </button>}
    </div>
  );
}
