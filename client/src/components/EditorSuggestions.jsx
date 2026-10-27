import React from 'react';
import EmojiSuggestions from './EmojiSuggestions';
import MentionSuggestions from './MentionSuggestions';

// The list for what's being typed in a message editor: `suggest` from useEditorSuggestions.
export default function EditorSuggestions({ suggest, s3Endpoint }) {
  if (!suggest.kind) return null;
  const common = {
    query: suggest.query,
    activeIndex: suggest.activeIndex,
    onPick: suggest.pick,
    onHover: suggest.setActiveIndex,
  };
  if (suggest.kind === 'emoji') return <EmojiSuggestions {...common} emojis={suggest.items} s3Endpoint={s3Endpoint} />;
  if (suggest.kind === 'channel') return <MentionSuggestions {...common} symbol="#" items={suggest.items} />;
  return <MentionSuggestions {...common} items={suggest.items} s3Endpoint={s3Endpoint} />;
}
