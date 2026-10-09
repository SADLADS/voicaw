import { useEffect } from 'react';
import { t } from '../i18n';

// The browser tab's title, which is also the desktop app's window title (Electron's window
// follows the page's <title>). Pages with none, or not known yet, are "Voicaw".
export const APP_TITLE = 'Voicaw';

// The title of an in-app page (Layout's routes). Deliberately the area, never who a chat is
// with: window titles leave the page (task switchers, screen-share pickers, window lists), and
// DMs and groups are end-to-end encrypted.
export function pageTitle(pathname, guilds = []) {
  if (pathname.startsWith('/settings')) return t('settings.pageTitle');
  if (pathname === '/dm/friends') return t('friends.title');
  if (pathname === '/dm/notes') return t('chat.notes.title');
  if (pathname === '/dm' || pathname.startsWith('/dm/')) return t('chat.dmList.title');
  const guildId = /^\/guild\/(\d+)/.exec(pathname)?.[1];
  if (guildId) return guilds.find((g) => String(g.id) === guildId)?.name || null;
  return null;
}

export function usePageTitle(title) {
  useEffect(() => {
    document.title = title || APP_TITLE;
  }, [title]);
  useEffect(() => () => { document.title = APP_TITLE; }, []);
}
