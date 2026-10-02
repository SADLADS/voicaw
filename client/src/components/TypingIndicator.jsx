import React from 'react';
import { displayName, useProfiles } from '../utils/profiles';
import { typingParts, useTyping } from '../utils/typing';

// "Alice is typing…" with three bouncing dots, just above the message box. Sits over the bottom
// of the message list (which leaves room for it), so it appearing doesn't move anything.
// `names` ({ userId: username }) are fallbacks for people without a loaded profile.
export default function TypingIndicator({ chatId, names }) {
  useProfiles();
  const userIds = useTyping(chatId);
  const parts = typingParts(userIds.map((id) => displayName(id, names?.[id] ?? 'Someone')));
  return (
    <div className="typing-indicator-slot">
      <div className="typing-indicator" aria-live="polite">
        {parts.length > 0 && (
          <>
            <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>
            <span className="typing-text">
              {parts.map((part, i) => (typeof part === 'string' ? part : <strong key={i}>{part.name}</strong>))}…
            </span>
          </>
        )}
      </div>
    </div>
  );
}
