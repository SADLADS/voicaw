import { useState } from 'react';
import { useEmojiIndex } from '../emoji/emojiContext';
import { useCustomEmoji } from '../emoji/customEmojiContext';
import {
  emojiQueryOf,
  insertSuggestedEmoji,
  replaceTypedShortcode,
  searchEmojiSuggestions,
} from '../emoji/emojiAutocomplete';

// The ":shortcode" suggestions (EmojiSuggestions) and ":shortcode:" replacing for an editor
// with only emoji to suggest: editing a message in place. (The message box has @, # and / too,
// and does the same in Composer.) `editorRef` is the MessageEditor's handle; pass `onChange` and
// `onKeyDown` on to it, the latter first (it says whether it took the key).
export function useEmojiSuggestions(editorRef, s3Endpoint) {
  const emojiIndex = useEmojiIndex();
  const custom = useCustomEmoji();
  const [beforeCaret, setBeforeCaret] = useState('');
  const [index, setIndex] = useState(0);
  // The query whose suggestions Escape closed.
  const [dismissed, setDismissed] = useState(null);

  const query = emojiQueryOf(beforeCaret, emojiIndex);
  const suggestions = query && query !== dismissed ? searchEmojiSuggestions(query, emojiIndex, custom) : [];
  const activeIndex = Math.min(index, Math.max(suggestions.length - 1, 0));

  function pick(emoji) {
    insertSuggestedEmoji(editorRef.current, query, emoji, s3Endpoint);
    setIndex(0);
  }

  function onChange({ beforeCaret: line, docChanged }) {
    setBeforeCaret(line);
    if (!docChanged) return;
    setIndex(0);
    replaceTypedShortcode(line, () => editorRef.current, { emojiIndex, custom, s3Endpoint });
  }

  // True when the key moved through, picked or closed the suggestions.
  function onKeyDown(e) {
    if (suggestions.length === 0) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setIndex((activeIndex + step + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      pick(suggestions[activeIndex]);
    } else if (e.key === 'Escape') {
      setDismissed(query);
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  }

  return { query, suggestions, activeIndex, setActiveIndex: setIndex, pick, onChange, onKeyDown };
}
