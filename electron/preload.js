// The page's window onto the desktop app: `window.voicawDesktop` (client/src/utils/desktop.js
// wraps it). Only these calls, never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

function listen(channel) {
    return (callback) => {
        const listener = (_event, value) => callback(value);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    };
}

contextBridge.exposeInMainWorld('voicawDesktop', {
    platform: process.platform,
    getInfo: () => ipcRenderer.invoke('desktop:info'),
    notify: (notification) => ipcRenderer.send('desktop:notify', notification),
    // Takes down the notification tagged `tag` (its chat was read).
    closeNotification: (tag) => ipcRenderer.send('desktop:close-notification', tag),
    setUnread: (unread) => ipcRenderer.send('desktop:unread', unread),
    getSettings: () => ipcRenderer.invoke('desktop:settings'),
    // Resolves to { settings, failedShortcuts }.
    updateSettings: (changes) => ipcRenderer.invoke('desktop:update-settings', changes),
    // 'available' | 'downloading' | 'current' | 'unsupported' | 'error'
    checkForUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
    // Looks once more for a newer version, downloads it if there is one, then restarts onto
    // it; resolves to false if there was nothing to install.
    installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
    // Screen sharing: { canShareSound, sources: [{ id, name, kind, thumbnail, icon }] }; then
    // chooseScreenSource(id, audio) before getDisplayMedia (electron/screenShare.js).
    getScreenSources: () => ipcRenderer.invoke('desktop:screen-sources'),
    chooseScreenSource: (id, audio) => ipcRenderer.invoke('desktop:choose-screen-source', id, audio),
    // The page's right-click menu: Electron's own paste, and its checker for what the page
    // has no dictionary for (electron/spellcheck.js), kept to the account's words.
    paste: () => ipcRenderer.send('desktop:paste'),
    spelling: {
        isMisspelled: (word) => webFrame.isWordMisspelled(String(word)),
        suggestions: (word) => webFrame.getWordSuggestions(String(word)),
    },
    setSpellingWords: (words) => ipcRenderer.send('desktop:spelling-words', words),
    // A linked page for a link preview in an encrypted chat (electron/pageFetch.js):
    // { status, url, contentType, html } or null.
    fetchPage: (url) => ipcRenderer.invoke('desktop:fetch-page', String(url)),
    // Saving a file a piece at a time (electron/fileSave.js): start(name) asks where (resolves
    // to an id, or null if cancelled), then append(id, Uint8Array) each piece, then finish(id),
    // or cancel(id) to delete what was written.
    saveFile: {
        start: (name) => ipcRenderer.invoke('desktop:save-start', String(name)),
        append: (id, bytes) => ipcRenderer.invoke('desktop:save-append', id, bytes),
        finish: (id) => ipcRenderer.invoke('desktop:save-finish', id),
        cancel: (id) => ipcRenderer.invoke('desktop:save-cancel', id),
    },
    // Files the app saved, for the download popup (electron/downloads.js): onDownload({ id,
    // name, folder }) as each one finishes; open(id) resolves to '' or why it couldn't.
    downloads: {
        open: (id) => ipcRenderer.invoke('desktop:download-open', id),
        showInFolder: (id) => ipcRenderer.invoke('desktop:download-show', id),
        remove: (id) => ipcRenderer.invoke('desktop:download-delete', id),
    },
    // Rich Presence: what the games on this computer say you're doing (electron/gameActivities.js),
    // now and whenever it changes.
    getActivities: () => ipcRenderer.invoke('desktop:activities'),
    // The in-game overlay (electron/overlay.js): what it shows of the voice channel or call
    // you're in (client utils/overlay.js), or null when you're not.
    setOverlayVoice: (state) => ipcRenderer.send('desktop:overlay-voice', state),
    // Push to talk while another app has focus (electron/pushToTalk.js): listens for `key`
    // (client voice/pushToTalkKeys.js; null stops), resolving whether it can; then
    // onPushToTalk(down) as it goes down and up.
    setPushToTalk: (key) => ipcRenderer.invoke('desktop:push-to-talk', key),
    // The page's own title bar (client components/DesktopTitleBar.jsx): the window's
    // { maximized, fullScreen, focused }, now and whenever it changes, and its buttons
    // ('minimize', 'maximize' (or back again), 'close': as the window's own close, so to the
    // tray if that's on).
    getWindowState: () => ipcRenderer.invoke('desktop:window-state'),
    windowAction: (action) => ipcRenderer.send('desktop:window', action),
    onWindowState: listen('desktop:window-state'),
    onActivities: listen('desktop:activities'),
    onDownload: listen('desktop:download-done'),
    onNavigate: listen('desktop:navigate'),
    onShortcut: listen('desktop:shortcut'),
    onPushToTalk: listen('desktop:push-to-talk'),
    onUpdateReady: listen('desktop:update-ready'),
    onUpdateProgress: listen('desktop:update-progress'), // 0 to 1, while downloading
});
