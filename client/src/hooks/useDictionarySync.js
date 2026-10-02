import { useEffect } from 'react';
import { startDictionarySync } from '../spellcheck/personalDictionary';

// Keeps the logged-in user's spellcheck dictionary loaded and current (Layout); forgotten on
// logging out.
export function useDictionarySync(userId) {
  useEffect(() => (userId ? startDictionarySync(userId) : undefined), [userId]);
}
