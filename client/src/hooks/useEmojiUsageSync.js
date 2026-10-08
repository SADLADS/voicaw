import { useEffect } from 'react';
import { startEmojiUsageSync } from '../emoji/emojiUsage';

// Keeps the logged-in user's emoji usage (Frequently Used, skin tone) loaded and current
// (Layout); forgotten on logging out.
export function useEmojiUsageSync(userId) {
  useEffect(() => (userId ? startEmojiUsageSync(userId) : undefined), [userId]);
}
