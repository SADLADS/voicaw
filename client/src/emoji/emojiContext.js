import { createContext, useContext } from 'react';

// The loaded emoji index (see emojiIndex.js), or null while it's loading.
export const EmojiContext = createContext(null);

export function useEmojiIndex() {
  return useContext(EmojiContext);
}
