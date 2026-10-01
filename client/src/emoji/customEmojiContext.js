import { createContext, useContext } from 'react';

// The custom emoji you can use (Layout provides it): { guilds: [{ guild, emojis }] in your
// guild rail order, byId: Map(id -> emoji, each with its `guild`) }.
export const CustomEmojiContext = createContext({ guilds: [], byId: new Map() });

export function useCustomEmoji() {
  return useContext(CustomEmojiContext);
}
