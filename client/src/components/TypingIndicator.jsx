import React from 'react';
import { Trans } from 'react-i18next';
import { displayName, useProfiles } from '../utils/profiles';
import { useTyping } from '../utils/typing';
import { t } from '../i18n';

const BOLD = { b: <strong /> };

// "Alice is typing…", "Alice and Bob are typing…", "Alice, Bob and Cal are typing…", then
// "Several people are typing…" (like Discord), names in bold. `names` are display names.
function TypingText({ names }) {
  const [a, b, c] = names;
  if (names.length > 3) return t('chat.typing.several');
  if (names.length === 3) return <Trans i18nKey="chat.typing.three" values={{ a, b, c }} components={BOLD} />;
  if (names.length === 2) return <Trans i18nKey="chat.typing.two" values={{ a, b }} components={BOLD} />;
  return <Trans i18nKey="chat.typing.one" values={{ a }} components={BOLD} />;
}

// "Alice is typing…" with three bouncing dots, just above the message box. Sits over the bottom
// of the message list (which leaves room for it), so it appearing doesn't move anything.
// `names` ({ userId: username }) are fallbacks for people without a loaded profile.
export default function TypingIndicator({ chatId, names }) {
  useProfiles();
  const userIds = useTyping(chatId);
  const typingNames = userIds.map((id) => displayName(id, names?.[id] ?? t('chat.reactions.someone')));
  return (
    <div className="typing-indicator-slot">
      <div className="typing-indicator" aria-live="polite">
        {typingNames.length > 0 && (
          <>
            <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>
            <span className="typing-text">
              <TypingText names={typingNames} />
            </span>
          </>
        )}
      </div>
    </div>
  );
}
