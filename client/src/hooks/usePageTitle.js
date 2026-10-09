import { useEffect } from 'react';
import { t } from '../i18n';
import { desktop } from '../utils/desktop';
import { displayName, useProfiles } from '../utils/profiles';
import { groupTitle } from '../utils/groupDisplay';

// The browser tab's title, and the desktop app's window title (Electron's window follows the
// page's <title>). The web has Discord's "Voicaw | @name", "Voicaw | #channel | Guild"; the
// desktop app only the area ("Direct Messages", the guild's name), since its window title is
// what the OS shows in the taskbar, the task switcher and screen-share pickers.
export const APP_TITLE = 'Voicaw';
const SEPARATOR = ' | ';

// An in-app page's title (Layout's routes): { desktop, web }. `desktop` is a string (null: none
// known yet), `web` the parts after "Voicaw". `data`: { guilds, layouts, groups, botDms, me }.
export function pageTitle(pathname, data = {}) {
  const { guilds = [], layouts = {}, groups = [], botDms = [], me = null } = data;
  const area = (title, web = [title]) => ({ desktop: title, web });

  if (pathname.startsWith('/settings')) return area(t('settings.pageTitle'));
  if (pathname === '/dm/friends') return area(t('friends.title'));
  if (pathname === '/dm/notes') return area(t('chat.notes.title'));
  if (pathname === '/dm' || pathname.startsWith('/dm/')) {
    const dms = t('chat.dmList.title');
    const [, kind, id] = /^\/dm\/(?:(g|b)\/)?([^/]+)/.exec(pathname) ?? [];
    if (kind === 'g') {
      const group = groups.find((g) => String(g.id) === id);
      return area(dms, group ? [groupTitle(group, me)] : [dms]);
    }
    const userId = kind === 'b' ? botDms.find((d) => String(d.id) === id)?.bot_id : id;
    const name = userId != null ? displayName(userId) : '';
    return area(dms, name ? [`@${name}`] : [dms]);
  }

  const [, guildId, channelId] = /^\/guild\/(\d+)(?:\/(\d+))?/.exec(pathname) ?? [];
  if (guildId) {
    const name = guilds.find((g) => String(g.id) === guildId)?.name;
    if (!name) return area(null, []);
    const layout = layouts[guildId];
    const channel = channelId && [...(layout?.channels ?? []), ...(layout?.threads ?? [])]
      .find((c) => String(c.id) === channelId);
    return area(name, channel ? [`#${channel.name}`, name] : [name]);
  }
  return area(null, []);
}

// What the title says: the desktop app's own string, or "Voicaw | …" on the web.
export function titleText({ desktop: desktopTitle, web }, isDesktop = Boolean(desktop)) {
  if (isDesktop) return desktopTitle || APP_TITLE;
  return [APP_TITLE, ...web].join(SEPARATOR);
}

// Sets the title; `title` is pageTitle's { desktop, web }, or one string for both.
export function usePageTitle(title) {
  const text = titleText(typeof title === 'string' || title == null
    ? { desktop: title, web: title ? [title] : [] }
    : title);
  useEffect(() => {
    document.title = text;
  }, [text]);
  useEffect(() => () => { document.title = APP_TITLE; }, []);
}

// Layout's: the title of whichever page is open. Redrawn when a profile changes (a DM's name).
export function useRouteTitle(pathname, data) {
  useProfiles();
  usePageTitle(pageTitle(pathname, data));
}
