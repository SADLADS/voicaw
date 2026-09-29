import React from 'react';
import defaultpfp from '../assets/images/default.png';

// The "@name" autocomplete list shown above the composer, like EmojiSuggestions (and styled
// the same): the chat's members matching `query`.
export default function MentionSuggestions({ query, people, activeIndex, onPick, onHover, s3Endpoint }) {
  return (
    <div className="emoji-suggestions mention-suggestions" role="listbox" aria-label="Members">
      <div className="emoji-suggestions-title">
        {query ? <>Members matching <strong>@{query}</strong></> : 'Members'}
      </div>
      {people.map((person, i) => (
        <div
          key={person.id}
          role="option"
          aria-selected={i === activeIndex}
          className={`emoji-suggestion${i === activeIndex ? ' active' : ''}`}
          // mousedown (not click) so the message box keeps focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(person);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <img
            className="mention-suggestion-avatar"
            src={s3Endpoint ? `${s3Endpoint}/profile-pics/${person.id}` : defaultpfp}
            alt=""
            draggable={false}
            onError={(e) => {
              e.currentTarget.onerror = null;
              e.currentTarget.src = defaultpfp;
            }}
          />
          <span>{person.username}</span>
        </div>
      ))}
    </div>
  );
}
