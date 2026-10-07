import { UNSAFE_createBrowserHistory as createBrowserHistory } from 'react-router-dom';

// Phones: Back works as in Discord's app, never like a browser's. From a chat it slides to the
// list (useSwipePanes), and from the list it leaves the app; it never goes through the chats
// and guilds seen before. So going from one chat page to another (a guild on the rail, a link
// in a message, a mention, Friends' Message) replaces the history entry instead of adding one,
// wherever the navigation comes from. Screens over a chat page keep their own entry, so Back
// closes them: a thread or a voice channel's chat (the same page, other search params),
// Settings and the developer portal (not chat pages), the image viewer (useBackCloses).

// The pages with the list and the chat (Layout's phone panes).
export function isPanesPage(pathname) {
  return /^\/(dm|guild)(\/|$)/.test(pathname);
}

// Whether going from `from` to `to` (pathnames) replaces the entry rather than adding one.
export function replacesEntry(from, to) {
  return from !== to && isPanesPage(from) && isPanesPage(to);
}

// The router's history (for unstable_HistoryRouter) with that rule on its pushes.
export function createPhoneHistory() {
  const history = createBrowserHistory({ v5Compat: true });
  const push = history.push.bind(history);
  history.push = (to, state) => {
    const { pathname } = history.createURL(to);
    if (replacesEntry(history.location.pathname, pathname)) history.replace(to, state);
    else push(to, state);
  };
  return history;
}
