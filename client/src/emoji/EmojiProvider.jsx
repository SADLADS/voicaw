import React, { useEffect, useState } from 'react';
import { EmojiContext } from './emojiContext';
import { loadEmojiIndex } from './emojiIndex';

// Loads the emoji data once for the whole app. Until it arrives, emoji render as plain
// (native) characters and the picker shows a loading state.
export default function EmojiProvider({ children }) {
  const [index, setIndex] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadEmojiIndex().then(
      (loaded) => { if (!cancelled) setIndex(loaded); },
      (err) => console.error('Failed to load emoji data', err)
    );
    return () => { cancelled = true; };
  }, []);

  return <EmojiContext.Provider value={index}>{children}</EmojiContext.Provider>;
}
