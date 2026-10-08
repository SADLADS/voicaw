import { useSyncExternalStore } from 'react';
import { t } from '../i18n';
import { createPopoutWindow } from './popoutWindow';

// Watch Together's player in a window of its own (popoutWindow.js), drawn into by
// WatchPartyPlayer. A page of ours (public/popout.html), not a blank window: YouTube's player
// needs the Referer that page gives it. The player starts afresh there (an iframe can't move
// without reloading) and catches up with the party. It closes when the party ends or you leave
// the channel; closing it puts the player back on the page.
export const WATCH_PARTY_WINDOW_NAME = 'voicaw-watch-together';

const watchPartyWindow = createPopoutWindow({
  name: WATCH_PARTY_WINDOW_NAME,
  url: '/popout.html',
  title: () => t('voice.watchParty.windowTitle'),
});

// False: the browser blocked it.
export const openWatchPartyWindow = () => watchPartyWindow.open();
export const closeWatchPartyWindow = () => watchPartyWindow.close();
export const setWatchPartyWindowTitle = (title) => watchPartyWindow.setTitle(title);

// Where the popped-out player is drawn, or null when it isn't.
export function useWatchPartyWindow() {
  return useSyncExternalStore(watchPartyWindow.subscribe, watchPartyWindow.get);
}
