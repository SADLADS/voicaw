import React from 'react';
import Avatar from './Avatar';

// The "@name" autocomplete list shown above the composer, like EmojiSuggestions (and styled
// the same): `items` from searchMentions (utils/mentions): people, roles (in their colour),
// @everyone and @here.
export default function MentionSuggestions({ query, items, activeIndex, onPick, onHover }) {
  return (
    <div className="emoji-suggestions mention-suggestions" role="listbox" aria-label="Mentions">
      <div className="emoji-suggestions-title">
        {query ? <>Matching <strong>@{query}</strong></> : 'Members'}
      </div>
      {items.map((item, i) => (
        <div
          key={`${item.kind}-${item.id ?? item.name}`}
          role="option"
          aria-selected={i === activeIndex}
          className={`emoji-suggestion mention-suggestion-${item.kind}${i === activeIndex ? ' active' : ''}`}
          // mousedown (not click) so the message box keeps focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
          onMouseEnter={() => onHover(i)}
        >
          {item.kind === 'user' ? (
            <>
              <Avatar userId={item.id} className="mention-suggestion-avatar" />
              <span>{item.name}</span>
              {item.username && item.username !== item.name && <span className="mention-suggestion-note">{item.username}</span>}
            </>
          ) : (
            <>
              <span className="mention-suggestion-at" style={item.color ? { color: item.color } : undefined}>@</span>
              <span style={item.color ? { color: item.color } : undefined}>{item.kind === 'everyone' ? `@${item.name}` : item.name}</span>
              {item.description && <span className="mention-suggestion-note">{item.description}</span>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
