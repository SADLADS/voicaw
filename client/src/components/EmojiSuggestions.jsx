import React from 'react';
import { emojiImageUrl } from '../emoji/emojiIndex';
import { getSkinTone, skinFor } from '../emoji/emojiUsage';

// The ":shortcode" autocomplete list shown above the composer (like Discord's).
export default function EmojiSuggestions({ query, emojis, activeIndex, onPick, onHover }) {
  const tone = getSkinTone();
  return (
    <div className="emoji-suggestions" role="listbox" aria-label={`Emoji matching ${query}`}>
      <div className="emoji-suggestions-title">Emoji matching <strong>{query}</strong></div>
      {emojis.map((emoji, i) => {
        const skin = skinFor(emoji, tone);
        return (
          <div
            key={emoji.id}
            role="option"
            aria-selected={i === activeIndex}
            className={`emoji-suggestion${i === activeIndex ? ' active' : ''}`}
            // mousedown (not click) so the textarea keeps focus.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(emoji);
            }}
            onMouseEnter={() => onHover(i)}
          >
            <img className="emoji" src={emojiImageUrl(skin.unified)} alt={skin.native} draggable={false} />
            <span>:{emoji.id}:</span>
          </div>
        );
      })}
    </div>
  );
}
