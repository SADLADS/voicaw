import React from 'react';
import { Trans } from 'react-i18next';
import { emojiImageUrl } from '../emoji/emojiIndex';
import { getSkinTone, skinFor } from '../emoji/emojiUsage';
import { customEmojiUrl } from '../emoji/customEmoji';
import { t } from '../i18n';

// The ":shortcode" autocomplete list shown above the composer (like Discord's). Custom emoji
// (with a `guild`) show their guild's name.
export default function EmojiSuggestions({ query, emojis, activeIndex, onPick, onHover, s3Endpoint }) {
  const tone = getSkinTone();
  return (
    <div className="emoji-suggestions" role="listbox" aria-label={t('chat.suggestions.emojiLabel', { query })}>
      <div className="emoji-suggestions-title"><Trans i18nKey="chat.suggestions.emojiTitle" values={{ query }} components={{ b: <strong /> }} /></div>
      {emojis.map((emoji, i) => {
        const skin = emoji.guild ? null : skinFor(emoji, tone);
        return (
          <div
            key={emoji.guild ? `c${emoji.id}` : emoji.id}
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
            {emoji.guild ? (
              <>
                <img className="emoji" src={customEmojiUrl(emoji.id, s3Endpoint)} alt={`:${emoji.name}:`} draggable={false} />
                <span>:{emoji.name}:</span>
                <span className="emoji-suggestion-guild">{emoji.guild.name}</span>
              </>
            ) : (
              <>
                <img className="emoji" src={emojiImageUrl(skin.unified)} alt={skin.native} draggable={false} />
                <span>:{emoji.id}:</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
