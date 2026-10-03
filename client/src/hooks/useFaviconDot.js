import { useEffect } from 'react';
import { desktop, unreadSummary } from '../utils/desktop';
import { setFaviconDot } from '../utils/faviconDot';

// The red dot on the browser tab's icon (from Layout): unread DMs and group messages, and guild
// mentions, as in Discord. Not in the desktop app, which has no tab (its tray has the dot).
export function useFaviconDot({ unreadDms, groups, guildUnread }) {
  const dot = !desktop && unreadSummary({ unreadDms, groups, guildUnread }).dot;
  useEffect(() => {
    setFaviconDot(dot);
  }, [dot]);

  // Logged out: nothing unread.
  useEffect(() => () => { setFaviconDot(false); }, []);
}
